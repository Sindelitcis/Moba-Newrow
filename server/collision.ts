import type { Entity, World } from 'murow';
import {
    BASE_RADIUS,
    CHAMPION_RADIUS,
    Components,
    KIND_BASE,
    KIND_TOWER,
    LANE_HALF,
    LANE_OVERRUN,
    LANE_WIDTH_HALF,
    MINION_RADIUS,
    TOWER_RADIUS,
    clamp,
    isMinion,
    isStructure,
} from '../shared';

/** Threshold under which a push counts as head-on and needs a side preference. */
const HEAD_ON_SIDEWAYS = 0.25;
/** How hard the side preference leans, relative to the head-on component. */
const SIDE_STEP_STRENGTH = 0.7;

function radiusFor(kind: number): number {
    if (kind === KIND_TOWER) return TOWER_RADIUS;
    if (kind === KIND_BASE) return BASE_RADIUS;
    if (isMinion(kind)) return MINION_RADIUS;
    return CHAMPION_RADIUS;
}

/**
 * Stable per-entity "which side do I step to" preference. Column-marching
 * minions spawn dead-center (x=0): a minion walking straight into a tower
 * also sitting at x=0 gets a near-zero sideways separation vector (almost pure
 * head-on), so without this it just gets pushed straight back into the minion
 * behind it and stacks up, relying on incidental noise from other collisions
 * to eventually break the tie. This forces a consistent left/right choice
 * immediately instead.
 */
function sidePreference(entity: Entity): 1 | -1 {
    return entity % 2 === 0 ? 1 : -1;
}

/**
 * When the natural push direction is mostly head-on (small sideways
 * component), blend in `entity`'s side preference so it actually steps around
 * the obstacle instead of just backing straight into whatever's behind it.
 */
function biasedPush(nx: number, nz: number, entity: Entity): { nx: number; nz: number } {
    if (Math.abs(nx) >= HEAD_ON_SIDEWAYS) return { nx, nz };
    const bx = sidePreference(entity) * SIDE_STEP_STRENGTH;
    const length = Math.hypot(bx, nz) || 1;
    return { nx: bx / length, nz: nz / length };
}

/**
 * Simple circle-vs-circle separation, run once per tick after movement. Not
 * real pathfinding, but a minion shoved sideways off a blocked lane keeps
 * trying to advance next tick, which reads as "walking around" the obstacle
 * instead of stacking on top of it or clipping through.
 *
 * Snapshots every position/kind into plain arrays up front and applies all
 * pushes in one final pass: `world.get()` returns a single object reused
 * across every call for that component type (see Murow's `component-store.ts`),
 * so holding two live `get()` results at once (e.g. `pa`/`pb` for a pair)
 * silently aliases them to the same underlying values. Reading everything into
 * primitives first, then only ever doing plain-number math, sidesteps that
 * trap entirely.
 */
export function resolveCollisions(world: World): void {
    const entities = [...world.query(Components.Position, Components.Kind)].filter((e) => world.isAlive(e));
    const count = entities.length;

    const xs = new Array<number>(count);
    const zs = new Array<number>(count);
    const radii = new Array<number>(count);
    const immovable = new Array<boolean>(count);
    const pushX = new Array<number>(count).fill(0);
    const pushZ = new Array<number>(count).fill(0);

    for (let i = 0; i < count; i++) {
        const kind = world.get(entities[i], Components.Kind).value;
        radii[i] = radiusFor(kind);
        // Towers and bases never move: only the other side of a pair is pushed.
        immovable[i] = isStructure(kind);

        const pos = world.get(entities[i], Components.Position);
        xs[i] = pos.x;
        zs[i] = pos.z;
    }

    for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
            if (immovable[i] && immovable[j]) continue; // two structures: neither moves

            const dx = xs[j] - xs[i];
            const dz = zs[j] - zs[i];
            const distance = Math.hypot(dx, dz);
            const minDistance = radii[i] + radii[j];
            if (distance >= minDistance) continue;

            // Exact overlap (distance === 0) still needs a direction to push
            // along, or the pair sits stuck on top of each other forever.
            const nx = distance > 1e-4 ? dx / distance : 1;
            const nz = distance > 1e-4 ? dz / distance : 0;
            const overlap = minDistance - distance;

            if (immovable[i]) {
                addPush(pushX, pushZ, j, biasedPush(nx, nz, entities[j]), overlap);
            } else if (immovable[j]) {
                addPush(pushX, pushZ, i, biasedPush(-nx, -nz, entities[i]), overlap);
            } else {
                // Neither is anchored: split the correction between them.
                addPush(pushX, pushZ, i, biasedPush(-nx, -nz, entities[i]), overlap * 0.5);
                addPush(pushX, pushZ, j, biasedPush(nx, nz, entities[j]), overlap * 0.5);
            }
        }
    }

    for (let i = 0; i < count; i++) {
        if (pushX[i] === 0 && pushZ[i] === 0) continue;
        world.update(entities[i], Components.Position, {
            x: clamp(xs[i] + pushX[i], -LANE_WIDTH_HALF, LANE_WIDTH_HALF),
            z: clamp(zs[i] + pushZ[i], -LANE_HALF - LANE_OVERRUN, LANE_HALF + LANE_OVERRUN),
        });
    }
}

function addPush(
    pushX: number[],
    pushZ: number[],
    index: number,
    direction: { nx: number; nz: number },
    amount: number,
): void {
    pushX[index] += direction.nx * amount;
    pushZ[index] += direction.nz * amount;
}
