import { clamp } from './math';
import { LANE_HALF, LANE_WIDTH_HALF, MOVE_SPEED, SPAWN_AREA_DEPTH } from './constants';

/**
 * Champions may walk behind their own base, into the spawn area, so the lane
 * reaches further along Z than the bases do.
 *
 * Exported because the walkable area has a second consumer now: the client's
 * pathfinder fences its navmesh into exactly this rectangle (see
 * src/game/navigation.ts), and a pathfinder that believed in a different
 * boundary from the clamp would happily route through ground the clamp then
 * refuses to let the champion enter.
 */
export const LANE_MAX_Z = LANE_HALF + SPAWN_AREA_DEPTH;

export interface Point2 {
    x: number;
    z: number;
}

/** Confines a position to the walkable area. The only place those bounds exist. */
export function clampToLane(x: number, z: number): Point2 {
    return {
        x: clamp(x, -LANE_WIDTH_HALF, LANE_WIDTH_HALF),
        z: clamp(z, -LANE_MAX_Z, LANE_MAX_Z),
    };
}

/**
 * Displaces a champion `distance` units along the direction `[dx, dz]`.
 *
 * The caller decides direction and distance; this decides where the lane ends.
 * Used by ordinary movement (`stepChampion`) and by the dash, so both are
 * bounded by the same rule.
 */
export function moveChampion(
    x: number,
    z: number,
    dx: number,
    dz: number,
    distance: number,
): Point2 {
    return clampToLane(x + dx * distance, z + dz * distance);
}

/**
 * One tick of champion movement.
 *
 * Used by the client-side prediction, by the server's authoritative replay of
 * that prediction, and by the bot. `dx`/`dz` are a direction, a unit vector for
 * full speed.
 */
export function stepChampion(
    x: number,
    z: number,
    dx: number,
    dz: number,
    deltaTime: number,
): Point2 {
    return moveChampion(x, z, dx, dz, MOVE_SPEED * deltaTime);
}

/**
 * Scales `[dx, dz]` to unit length, or returns null if it has no direction.
 *
 * Direction arrives over the wire, so it may be zero, denormalised or NaN. The
 * server normalises rather than trusting it: distance is the server's to decide
 * and must not be smuggled in through a long vector.
 */
export function normalize(dx: number, dz: number): { dx: number; dz: number } | null {
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 1e-4) return null;
    return { dx: dx / length, dz: dz / length };
}
