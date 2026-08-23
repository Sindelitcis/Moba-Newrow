import type { PrefabBucket } from 'murow';
import type { InstanceHandle, WebGPU3DRenderer } from 'murow/webgpu';
import { CLEAVE_RANGE, KIND_BASE, KIND_TOWER } from '../../shared';
import { scaleTuple, TEAM_COLOR } from './unit-visuals';

/**
 * Short-lived combat visuals, all built from the same `unit` cube.
 *
 * Everything here is time-driven from `tick()` rather than `setTimeout`: a
 * timer that fires after the session it belongs to has been torn down would
 * be calling `destroy()`/`setScale()` on a handle whose renderer slot has
 * already been recycled, which corrupts an unrelated instance rather than
 * failing loudly. Expiry timestamps checked on the tick that's already
 * running have no such window.
 */
export interface Effects {
    /** Bright flash sized to a unit: used when your own champion is hit. */
    hitFlash(x: number, y: number, z: number, kind: number): void;
    /** Small spark confirming a hit you landed, wherever the server says it landed. */
    spark(x: number, y: number, z: number): void;
    /** Travelling dot from attacker to target. */
    bolt(fromX: number, fromZ: number, toX: number, toZ: number): void;
    /** Expanding shockwave marking a cleave. */
    cleaveWave(x: number, z: number, team: number): void;
    /** Motes rising off someone who just drank. */
    healBloom(x: number, z: number): void;
    /** Afterimages along the path a champion just dashed. */
    dashTrail(fromX: number, fromZ: number, toX: number, toZ: number, team: number): void;
    /** Quick scale-up on an existing instance: "you swung" feedback. */
    pulse(handle: InstanceHandle, kind: number): void;
    /** Drops any pending pulse on `handle`, before the caller destroys it. */
    forget(handle: InstanceHandle): void;
    tick(): void;
    /** Destroys every live effect instance. */
    dispose(): void;
}

/** A world point, for the ends of a transient's travel. */
interface Point {
    x: number;
    y: number;
    z: number;
}

/**
 * A temporary instance, lerped from `from` to `to` over its life.
 *
 * The ones that don't travel simply have the two equal, rather than leaving the
 * destination undefined and branching on it: that version needed a non-null
 * assertion per axis in the update loop, which is three chances to get it wrong
 * for no benefit.
 */
interface Transient {
    handle: InstanceHandle;
    bornAt: number;
    duration: number;
    from: Point;
    to: Point;
}

interface PendingRestore {
    handle: InstanceHandle;
    scale: [number, number, number];
    at: number;
}

const FLASH_MS = 130;
const SPARK_MS = 170;
const BOLT_MS = 150;
const BOLT_Y = 0.5;
const CLEAVE_MS = 260;
const CLEAVE_SPOKES = 10;
const PULSE_MS = 90;
const PULSE_SCALE = 1.3;
const HEAL_MS = 700;
const HEAL_MOTES = 6;
/** Radius the motes drift out to, and how high they rise, in world units. */
const HEAL_SPREAD = 0.55;
const HEAL_RISE = 1.9;
const DASH_MS = 320;
const DASH_AFTERIMAGES = 7;
/** Height of the afterimages, roughly a champion's waist. */
const DASH_Y = 0.8;

function flashSize(kind: number): number {
    if (kind === KIND_BASE) return 2.0;
    if (kind === KIND_TOWER) return 1.3;
    return 0.7;
}

export function createEffects(renderer: WebGPU3DRenderer, prefabs: PrefabBucket): Effects {
    const live: Transient[] = [];
    const restores: PendingRestore[] = [];

    /** Adds a cube that travels from `from` to `to` and expires. */
    function spawn(
        color: [number, number, number],
        from: Point,
        to: Point,
        scale: number,
        duration: number,
    ): void {
        const handle = renderer.addInstance({
            model: prefabs.get('unit'),
            color,
            position: [from.x, from.y, from.z],
            scale,
        });
        live.push({ handle, bornAt: performance.now(), duration, from, to });
    }

    /** Adds a cube that just sits where it is until it expires. */
    function spawnStill(
        color: [number, number, number],
        at: Point,
        scale: number,
        duration: number,
    ): void {
        spawn(color, at, at, scale, duration);
    }

    return {
        hitFlash(x, y, z, kind) {
            spawnStill([1, 0.95, 0.55], { x, y, z }, flashSize(kind), FLASH_MS);
        },

        spark(x, y, z) {
            spawnStill([1, 0.8, 0.35], { x, y, z }, 0.55, SPARK_MS);
        },

        // Deliberately NOT a rotated stretched cube: murow/webgpu's Euler
        // rotation convention isn't documented, and getting the yaw math wrong
        // would silently point the effect the wrong way every time. A
        // straight-line travelling dot only needs position lerp, so there's no
        // rotation convention to get wrong.
        bolt(fromX, fromZ, toX, toZ) {
            spawn(
                [1, 0.85, 0.3],
                { x: fromX, y: BOLT_Y, z: fromZ },
                { x: toX, y: BOLT_Y, z: toZ },
                0.3,
                BOLT_MS,
            );
        },

        cleaveWave(x, z, team) {
            const [r, g, b] = TEAM_COLOR[team] ?? [1, 1, 1];
            const color: [number, number, number] = [
                1 - (1 - r) * 0.4,
                1 - (1 - g) * 0.4,
                1 - (1 - b) * 0.4,
            ];
            for (let i = 0; i < CLEAVE_SPOKES; i++) {
                const angle = (i / CLEAVE_SPOKES) * Math.PI * 2;
                spawn(
                    color,
                    { x, y: 0.45, z },
                    {
                        x: x + Math.cos(angle) * CLEAVE_RANGE,
                        y: 0.45,
                        z: z + Math.sin(angle) * CLEAVE_RANGE,
                    },
                    0.28,
                    CLEAVE_MS,
                );
            }
        },

        // Rising green motes rather than a flash: a potion is a *sustained*
        // heal, and a one-frame pop would read as an instant one. Green because
        // nothing else in this game is: every other effect is in the warm
        // damage family or a team color.
        healBloom(x, z) {
            for (let i = 0; i < HEAL_MOTES; i++) {
                const angle = (i / HEAL_MOTES) * Math.PI * 2;
                const offsetX = Math.cos(angle) * HEAL_SPREAD;
                const offsetZ = Math.sin(angle) * HEAL_SPREAD;
                spawn(
                    [0.45, 1, 0.55],
                    { x: x + offsetX * 0.4, y: 0.15, z: z + offsetZ * 0.4 },
                    { x: x + offsetX, y: HEAL_RISE, z: z + offsetZ },
                    0.16,
                    HEAL_MS,
                );
            }
        },

        // Afterimages along the path, in the dasher's team color so it reads as
        // "who moved" and not just "something happened". Lifetimes ramp along
        // the path so the tail clears first and the trail dissipates from the
        // origin forward, rather than blinking out all at once.
        dashTrail(fromX, fromZ, toX, toZ, team) {
            const [r, g, b] = TEAM_COLOR[team] ?? [1, 1, 1];
            const color: [number, number, number] = [
                1 - (1 - r) * 0.55,
                1 - (1 - g) * 0.55,
                1 - (1 - b) * 0.55,
            ];
            for (let i = 0; i < DASH_AFTERIMAGES; i++) {
                const t = i / (DASH_AFTERIMAGES - 1);
                spawnStill(
                    color,
                    { x: fromX + (toX - fromX) * t, y: DASH_Y, z: fromZ + (toZ - fromZ) * t },
                    0.34,
                    DASH_MS * (0.35 + 0.65 * t),
                );
            }
        },

        pulse(handle, kind) {
            const scale = scaleTuple(kind);
            // Already pulsing: refresh the deadline rather than stacking a
            // second restore that would snap back to an inflated size.
            const existing = restores.find((r) => r.handle === handle);
            if (existing !== undefined) {
                existing.at = performance.now() + PULSE_MS;
                return;
            }
            handle.setScale(scale[0] * PULSE_SCALE, scale[1] * PULSE_SCALE, scale[2] * PULSE_SCALE);
            restores.push({ handle, scale, at: performance.now() + PULSE_MS });
        },

        forget(handle) {
            const index = restores.findIndex((r) => r.handle === handle);
            if (index !== -1) restores.splice(index, 1);
        },

        tick() {
            const now = performance.now();

            for (let i = live.length - 1; i >= 0; i--) {
                const { handle, from, to, bornAt, duration } = live[i];
                const progress = Math.min(1, (now - bornAt) / duration);
                handle.setPosition(
                    from.x + (to.x - from.x) * progress,
                    from.y + (to.y - from.y) * progress,
                    from.z + (to.z - from.z) * progress,
                );
                if (progress >= 1) {
                    handle.destroy();
                    live.splice(i, 1);
                }
            }

            for (let i = restores.length - 1; i >= 0; i--) {
                const r = restores[i];
                if (now < r.at) continue;
                r.handle.setScale(r.scale[0], r.scale[1], r.scale[2]);
                restores.splice(i, 1);
            }
        },

        dispose() {
            for (const t of live) t.handle.destroy();
            live.length = 0;
            restores.length = 0;
        },
    };
}
