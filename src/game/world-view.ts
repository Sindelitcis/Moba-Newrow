import type { Entity, PrefabBucket, World } from 'murow';
import type { InstanceHandle, WebGPU3DRenderer } from 'murow/webgpu';
import { Components, KIND_BASE, isStructure } from '../../shared';
import type { Effects } from './effects';
import type { FacingTracker } from './facing';
import type { HpBars } from './hp-bars';
import { buildNexus } from './nexus';
import { worldToScreen } from './projection';
import { barHeight, centerHeight, colorFor, TEAM_COLOR, visualFor } from './unit-visuals';

/** What the view needs to know about the local player, refreshed every tick. */
export interface ViewState {
    localEntity: Entity | null;
    myTeam: number | null;
    /** Cursor position in canvas CSS px, or -1 when the cursor is off-canvas. */
    mouseX: number;
    mouseY: number;
    width: number;
    height: number;
    /**
     * The camera's view-projection matrix for this tick, sampled once by the
     * session after the camera has been moved.
     *
     * Passed in rather than fetched per consumer: four of them need it now that
     * click-to-move has to unproject as well as project, and each fetching its
     * own invited one of them to read it before `updateCamera` had run.
     */
    viewProjection: Float32Array;
}

/**
 * One unit as of the last `sync`.
 *
 * Built once per tick and then read by everything that needs "what is on the
 * board right now": hover testing, the minimap, the range ring's in-range
 * check. Those each used to walk the world themselves, which meant three
 * passes and three separate chances to fall into the `world.get()` aliasing
 * trap (it returns one object per component type, reused across every call).
 * One pass, plain numbers, no aliasing.
 *
 * The objects are reused between ticks: callers may read them during the tick
 * they were handed, and must not retain them.
 */
export interface UnitSnapshot {
    entity: Entity;
    team: number;
    kind: number;
    x: number;
    z: number;
    /** 0..1, or 1 for units with no Health component. */
    hpFraction: number;
    /** True while this structure can't be damaged yet (a nexus behind its towers). */
    shielded: boolean;
}

export interface WorldView {
    onSpawn(entity: Entity): void;
    onDespawn(entity: Entity): void;
    /** Pushes world state into the renderer, bars, effects and hover target. */
    sync(state: ViewState): void;
    /** Every live unit as of the last `sync`. Reused between ticks: read, don't retain. */
    readonly units: readonly UnitSnapshot[];
    /** Enemy under the cursor as of the last `sync`, or null. */
    readonly hoveredEnemy: UnitSnapshot | null;
    handleOf(entity: Entity): InstanceHandle | undefined;
    dispose(): void;
}

export interface WorldViewDeps {
    world: World;
    renderer: WebGPU3DRenderer;
    prefabs: PrefabBucket;
    bars: HpBars;
    effects: Effects;
    facing: FacingTracker;
    /** The local champion just lost health. */
    onLocalDamaged(): void;
    /**
     * A tower or base was destroyed. Left to the caller rather than played
     * here because the arena rebuild between matches despawns every structure
     * at once: six explosions in one frame is a bug, not a flourish, and only
     * the session knows a reset is under way.
     */
    onStructureDestroyed(): void;
}

/** Immutable per-entity facts, captured at spawn so they survive despawn. */
interface UnitMeta {
    team: number;
    kind: number;
}

/**
 * Everything that turns networked entities into things on screen: renderer
 * instances, health bars, damage reactions, and which enemy the cursor is
 * over.
 *
 * Scoped to one connection: an entity id only means anything relative to the
 * `World` it came from, so a reconnect throws this whole object away and
 * builds a new one rather than trying to reconcile two generations of ids.
 */
export function createWorldView(deps: WorldViewDeps): WorldView {
    const { world, renderer, prefabs, bars, effects, facing } = deps;

    const handles = new Map<Entity, InstanceHandle>();
    /** Extra static instances owned by an entity: the nexus around a base. */
    const props = new Map<Entity, InstanceHandle[]>();
    const meta = new Map<Entity, UnitMeta>();

    /**
     * Snapshot storage. `unitPool` owns the objects and grows to the high-water
     * mark of live entities; `units` is refilled with references to them every
     * `sync`, so a full tick of bookkeeping allocates nothing at all.
     */
    const unitPool: UnitSnapshot[] = [];
    const units: UnitSnapshot[] = [];

    // Last seen health of the local champion, to notice it taking a hit. Keyed
    // by entity as well as value: a respawn is a *new* entity at full health,
    // and comparing across the two would be meaningless.
    let lastLocalEntity: Entity | null = null;
    let lastLocalHp = 0;

    let hoveredEnemy: UnitSnapshot | null = null;

    function readMeta(entity: Entity): UnitMeta {
        return {
            team: world.has(entity, Components.Team) ? world.get(entity, Components.Team).id : 0,
            kind: world.has(entity, Components.Kind) ? world.get(entity, Components.Kind).value : 0,
        };
    }

    /**
     * Re-plays the model's first clip at a jittered speed. The clip is already
     * playing by this point: `addSkinnedInstance` starts clip 0 looping for
     * any model that has clips, so the only thing this changes is the rate,
     * which keeps a wave of six identical minions from animating in perfect
     * lockstep. Read by index rather than by name so swapping in a different
     * model needs no matching change here.
     */
    function playIdle(handle: InstanceHandle, modelId: string): void {
        if (handle.play === undefined) return;
        const prefab = prefabs.get(modelId) as unknown as {
            animationList?: readonly string[];
            animations?: Record<string, string>;
        };
        const clip = prefab.animationList?.[0] ?? Object.values(prefab.animations ?? {})[0];
        if (clip === undefined) return;
        handle.play(clip, { loop: true, speed: 0.85 + Math.random() * 0.3 });
    }

    /** Borrows the next snapshot slot, growing the pool only on the first few ticks. */
    function takeSlot(index: number): UnitSnapshot {
        let slot = unitPool[index];
        if (slot === undefined) {
            slot = { entity: 0, team: 0, kind: 0, x: 0, z: 0, hpFraction: 1, shielded: false };
            unitPool[index] = slot;
        }
        return slot;
    }

    function updateHover(state: ViewState, vp: Float32Array): void {
        hoveredEnemy = null;
        if (state.mouseX < 0 || state.myTeam === null) return;

        let bestDistance = Infinity;
        for (const unit of units) {
            if (unit.entity === state.localEntity || unit.team === state.myTeam) continue;

            const screen = worldToScreen(vp, unit.x, centerHeight(unit.kind), unit.z, state.width, state.height);
            if (screen === null) continue;

            const distancePx = Math.hypot(screen.x - state.mouseX, screen.y - state.mouseY);
            if (distancePx <= visualFor(unit.kind).hitRadiusPx && distancePx < bestDistance) {
                bestDistance = distancePx;
                hoveredEnemy = unit;
            }
        }
    }

    return {
        get units() {
            return units;
        },

        get hoveredEnemy() {
            return hoveredEnemy;
        },

        handleOf(entity) {
            return handles.get(entity);
        },

        onSpawn(entity) {
            const unit = readMeta(entity);
            meta.set(entity, unit);

            const visual = visualFor(unit.kind);
            const pos = world.has(entity, Components.Position)
                ? world.get(entity, Components.Position)
                : { x: 0, z: 0 };
            const x = pos.x;
            const z = pos.z;

            const handle = renderer.addInstance({
                model: prefabs.get(visual.modelId),
                color: colorFor(unit.team, unit.kind),
                position: [x, visual.originY, z],
                scale: visual.scale,
                rotation: visual.rotation,
            });
            handles.set(entity, handle);
            playIdle(handle, visual.modelId);

            if (unit.kind === KIND_BASE) {
                props.set(entity, buildNexus(renderer, prefabs, TEAM_COLOR[unit.team] ?? [0.6, 0.6, 0.6], x, z));
            }
            if (world.has(entity, Components.Health)) bars.add(entity, unit.team, unit.kind);
        },

        onDespawn(entity) {
            const handle = handles.get(entity);
            if (handle !== undefined) {
                effects.forget(handle);
                handle.destroy();
            }
            handles.delete(entity);

            for (const prop of props.get(entity) ?? []) prop.destroy();
            props.delete(entity);

            const unit = meta.get(entity);
            if (unit !== undefined && isStructure(unit.kind)) deps.onStructureDestroyed();

            meta.delete(entity);
            facing.forget(entity);
            bars.remove(entity);
        },

        sync(state) {
            const vp = state.viewProjection;
            units.length = 0;

            for (const [entity, handle] of handles) {
                const unit = meta.get(entity);
                if (unit === undefined || !world.has(entity, Components.Position)) continue;

                // Extract every field to a plain number *immediately* after
                // each `world.get()`: it returns one object reused across
                // every call for that component type, so any other read of the
                // same component in between would silently corrupt these in
                // place.
                const pos = world.get(entity, Components.Position);
                const x = pos.x;
                const z = pos.z;

                handle.setPosition(x, visualFor(unit.kind).originY, z);
                facing.update(entity, handle, unit.kind, x, z);

                const slot = takeSlot(units.length);
                units.push(slot);
                slot.entity = entity;
                slot.team = unit.team;
                slot.kind = unit.kind;
                slot.x = x;
                slot.z = z;
                slot.hpFraction = 1;
                slot.shielded = world.has(entity, Components.Shield)
                    && world.get(entity, Components.Shield).active === 1;

                if (!world.has(entity, Components.Health)) continue;
                const health = world.get(entity, Components.Health);
                const current = health.current;
                const max = health.max;
                slot.hpFraction = max > 0 ? current / max : 0;

                // Damage reactions are for *your* champion only. Every other
                // unit just shows its health bar moving: a lane full of minions
                // trading blows used to strobe the whole screen, and none of it
                // was information the player could act on. Hits you land get
                // their own feedback, driven by the server's `hitLanded` (see
                // session.ts).
                if (entity === state.localEntity) {
                    if (entity === lastLocalEntity && current < lastLocalHp) {
                        effects.hitFlash(x, centerHeight(unit.kind), z, unit.kind);
                        deps.onLocalDamaged();
                    }
                    lastLocalEntity = entity;
                    lastLocalHp = current;
                }

                bars.place(entity, {
                    screen: worldToScreen(vp, x, barHeight(unit.kind), z, state.width, state.height),
                    fraction: slot.hpFraction,
                    shielded: slot.shielded,
                });
            }

            updateHover(state, vp);
            bars.highlight(hoveredEnemy?.entity ?? null);
        },

        dispose() {
            for (const handle of handles.values()) handle.destroy();
            for (const group of props.values()) {
                for (const prop of group) prop.destroy();
            }
            handles.clear();
            props.clear();
            meta.clear();
            units.length = 0;
            lastLocalEntity = null;
            bars.clear();
            hoveredEnemy = null;
        },
    };
}
