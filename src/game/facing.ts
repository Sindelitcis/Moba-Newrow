import type { Entity } from 'murow';
import type { InstanceHandle } from 'murow/webgpu';
import { KIND_BASE, KIND_TOWER } from '../../shared';

/**
 * Which way each model is turned.
 *
 * Nothing on the wire carries a heading: Position is the only per-tick
 * networked component, so facing is derived client-side from how an entity
 * actually moved between ticks, then smoothed. Purely cosmetic: the server
 * resolves targeting by distance and never by where a model is looking.
 * Without it, champions and minions moonwalk down the lane sideways, which
 * undoes most of the benefit of having real models at all.
 */
export interface FacingTracker {
    update(entity: Entity, handle: InstanceHandle, kind: number, x: number, z: number): void;
    forget(entity: Entity): void;
}

/**
 * Both skinned models are authored facing +Z, so a heading of
 * `atan2(dx, dz)` already points them the right way and no correction is
 * needed. Kept as a named constant because it's the first thing to flip (to
 * `Math.PI`) if a swapped-in model turns out to face the other way.
 */
const MODEL_FORWARD_YAW_OFFSET = 0;

/** Fraction of the remaining turn applied per tick: 1 snaps, lower is smoother. */
const TURN_RATE = 0.25;

/** Movement below this (world units per tick) is interpolation noise, not a turn. */
const MOVEMENT_EPSILON = 1e-3;

interface Facing {
    x: number;
    z: number;
    yaw: number;
}

/** Shortest signed angular distance from `a` to `b`, in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

export function createFacingTracker(): FacingTracker {
    const facings = new Map<Entity, Facing>();

    return {
        update(entity, handle, kind, x, z) {
            // Structures never turn, and the tower's instance rotation is
            // already carrying its Z-up correction (see GLTF_ROTATION_TOWER) -
            // writing a yaw over it would flatten that back out.
            if (kind === KIND_TOWER || kind === KIND_BASE) return;

            const facing = facings.get(entity);
            if (facing === undefined) {
                facings.set(entity, { x, z, yaw: 0 });
                return;
            }

            const dx = x - facing.x;
            const dz = z - facing.z;
            facing.x = x;
            facing.z = z;

            if (Math.hypot(dx, dz) > MOVEMENT_EPSILON) {
                const target = Math.atan2(dx, dz) + MODEL_FORWARD_YAW_OFFSET;
                facing.yaw += angleDelta(facing.yaw, target) * TURN_RATE;
            }
            handle.setRotation(0, facing.yaw, 0);
        },

        forget(entity) {
            facings.delete(entity);
        },
    };
}
