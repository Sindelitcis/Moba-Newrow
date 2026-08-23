import type { Entity, World } from 'murow';
import { Components } from '../shared';

/**
 * Target selection. Everything here is O(n) over all Position+Team+Health
 * entities: fine at 3v3 prototype scale (a few dozen entities); revisit with
 * spatial partitioning if the entity count ever grows.
 */

/** A shielded structure isn't a legal target at all, so nothing wastes a swing on it. */
function isTargetable(world: World, entity: Entity): boolean {
    return !world.has(entity, Components.Shield)
        || world.get(entity, Components.Shield).active === 0;
}

/** Runs `visit` for every alive, targetable enemy of `fromEntity` within `range`. */
function forEachEnemyInRange(
    world: World,
    fromEntity: Entity,
    range: number,
    kindFilter: readonly number[] | undefined,
    visit: (entity: Entity, distance: number) => void,
): void {
    if (!world.has(fromEntity, Components.Position) || !world.has(fromEntity, Components.Team)) return;

    // Read to primitives immediately: `world.get()` hands back one object
    // reused across every call for a given component type, so the `pos` read
    // inside the loop below would otherwise alias these away.
    const fromPos = world.get(fromEntity, Components.Position);
    const fx = fromPos.x;
    const fz = fromPos.z;
    const fromTeam = world.get(fromEntity, Components.Team).id;

    for (const e of world.query(Components.Position, Components.Team, Components.Health)) {
        if (e === fromEntity) continue;
        if (world.get(e, Components.Team).id === fromTeam) continue;
        if (!isTargetable(world, e)) continue;

        if (kindFilter !== undefined) {
            const kind = world.has(e, Components.Kind) ? world.get(e, Components.Kind).value : -1;
            if (!kindFilter.includes(kind)) continue;
        }

        const pos = world.get(e, Components.Position);
        const distance = Math.hypot(pos.x - fx, pos.z - fz);
        if (distance <= range) visit(e, distance);
    }
}

/**
 * Nearest alive enemy (different Team) within `range` of `fromEntity`,
 * optionally restricted to a set of Kind values (e.g. towers shoot minions
 * before champions). Returns `null` when nothing qualifies.
 */
export function findNearestEnemyInRange(
    world: World,
    fromEntity: Entity,
    range: number,
    kindFilter?: readonly number[],
): Entity | null {
    let best: Entity | null = null;
    let bestDistance = Infinity;

    forEachEnemyInRange(world, fromEntity, range, kindFilter, (e, distance) => {
        if (distance >= bestDistance) return;
        bestDistance = distance;
        best = e;
    });

    return best;
}

/**
 * Every alive enemy within `range` of `fromEntity`: the cleave's "hit
 * whatever is around me" targeting. Returns a fresh array, so it's safe to
 * damage (and despawn) the entities in it while iterating.
 */
export function findEnemiesInRange(
    world: World,
    fromEntity: Entity,
    range: number,
    kindFilter?: readonly number[],
): Entity[] {
    const found: Entity[] = [];
    forEachEnemyInRange(world, fromEntity, range, kindFilter, (e) => found.push(e));
    return found;
}

/**
 * Of the enemies `fromEntity` can legally hit, the one closest to
 * `[aimX, aimZ]`: i.e. what the attacker was pointing at.
 *
 * Choosing among already-validated candidates is what makes it safe to let the
 * *client* say where it aimed: the aim point only ranks targets that were
 * hittable anyway, so a bogus one can't reach further, hit a team-mate, or
 * touch anything that isn't already in range.
 */
export function findEnemyNearestAim(
    world: World,
    fromEntity: Entity,
    range: number,
    aimX: number,
    aimZ: number,
): Entity | null {
    let best: Entity | null = null;
    let bestDistance = Infinity;

    forEachEnemyInRange(world, fromEntity, range, undefined, (e) => {
        const pos = world.get(e, Components.Position);
        const distance = Math.hypot(pos.x - aimX, pos.z - aimZ);
        if (distance >= bestDistance) return;
        bestDistance = distance;
        best = e;
    });

    return best;
}
