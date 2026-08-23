import type { Entity, World } from 'murow';
import {
    BASE_HP,
    CHAMPION_HP,
    CHAMPION_SPAWN_SETBACK,
    Components,
    KIND_BASE,
    KIND_CHAMPION,
    KIND_MINION,
    KIND_MINION_CASTER,
    KIND_TOWER,
    MINION_FILE_GAP,
    MINION_RANK_GAP,
    MINIONS_MELEE_PER_WAVE,
    MINIONS_PER_RANK,
    MINIONS_PER_WAVE,
    MINION_STATS,
    NEXUS_REQUIRES_TOWERS_DOWN,
    TEAMS,
    TOWER_HP,
    TOWER_INNER_Z,
    TOWER_OUTER_Z,
    baseZ,
    forwardZ,
    isStructure,
} from '../shared';

/** X offsets of a team's three spawn slots (0/1/2 → left/mid/right). */
const CHAMPION_SPAWN_X = [-2, 0, 2];

/**
 * Adds the components every unit shares.
 *
 * Two of them are conditional, and both conditions are load-bearing:
 * `Timers` doubles as the "can attack" marker the tick systems query on, so
 * bases deliberately don't get it (they have Health but never swing), and
 * `Shield` only exists on structures because it is the nexus-behind-its-towers
 * rule (see server/systems.ts).
 */
function spawnUnit(world: World, team: number, kind: number, hp: number, x: number, z: number): Entity {
    const e = world.spawn();
    world.add(e, Components.Position, { x, z });
    world.add(e, Components.Team, { id: team });
    world.add(e, Components.Kind, { value: kind });
    world.add(e, Components.Health, { current: hp, max: hp });
    if (kind !== KIND_BASE) world.add(e, Components.Timers, { ...Components.ZERO_TIMERS });
    // A base starts shielded because a fresh arena always has towers standing;
    // seeding it correctly here rather than waiting for the first tick's
    // recompute closes the one-tick window where a reset nexus is hittable.
    if (isStructure(kind)) {
        const shielded = kind === KIND_BASE && NEXUS_REQUIRES_TOWERS_DOWN;
        world.add(e, Components.Shield, { active: shielded ? 1 : 0 });
    }
    return e;
}

/** Spawns both bases and all 4 towers (2 per team). Call once per match. */
export function spawnStructures(world: World): void {
    for (const team of TEAMS) {
        spawnUnit(world, team, KIND_BASE, BASE_HP, 0, baseZ(team));
        // Towers sit between the base and mid, so they're on the base's side of Z.
        for (const distance of [TOWER_OUTER_Z, TOWER_INNER_Z]) {
            spawnUnit(world, team, KIND_TOWER, TOWER_HP, 0, -forwardZ(team) * distance);
        }
    }
}

/**
 * Where `team`'s champion in spawn slot `slot` (0/1/2 → left/mid/right)
 * starts: *behind* its own base, not in front of it. See
 * `CHAMPION_SPAWN_SETBACK` for why that matters.
 */
export function championSpawnPoint(team: number, slot: number): { x: number; z: number } {
    return {
        x: CHAMPION_SPAWN_X[slot % CHAMPION_SPAWN_X.length],
        z: baseZ(team) - forwardZ(team) * CHAMPION_SPAWN_SETBACK,
    };
}

/** Spawns one champion for `team` at spawn slot `slot`. */
export function spawnChampion(world: World, team: number, slot: number): Entity {
    const { x, z } = championSpawnPoint(team, slot);
    return spawnUnit(world, team, KIND_CHAMPION, CHAMPION_HP, x, z);
}

/**
 * Returns an existing champion to its spawn point at full health, without
 * destroying and recreating the entity.
 *
 * Used by the match reset instead of despawn+spawn, and the distinction
 * matters: the ECS recycles entity ids immediately, so a champion despawned
 * and respawned in the same tick comes back with the *same* id. The client
 * would then receive `assigned <id>` for the new champion before the old
 * champion's `despawn <id>`: indistinguishable from its current champion
 * dying, which left the "respawning in Ns" overlay stuck on screen forever.
 * Keeping the entity alive sidesteps the whole ordering problem, and it also
 * means `peer.entity` never goes stale across a reset.
 */
export function resetChampion(world: World, entity: Entity, team: number, slot: number): void {
    const { x, z } = championSpawnPoint(team, slot);
    world.update(entity, Components.Position, { x, z });
    world.update(entity, Components.Health, { current: CHAMPION_HP, max: CHAMPION_HP });
    world.update(entity, Components.Timers, { ...Components.ZERO_TIMERS });
}

/**
 * Spawns a wave for `team` at their base, walking the lane toward the enemy.
 *
 * Ranks abreast, melee in front. The formation is load-bearing rather than
 * decorative: a minion only attacks what is inside its own range, so the width
 * of the wave decides how many of it can fight at once. A single-file column
 * puts about three minions in contact no matter how long it is, which caps the
 * rate the two sides can kill each other at roughly the rate they spawn. The
 * result is a queue that grows without ever advancing.
 *
 * Laying each rank across the lane instead puts the whole wave in contact, so a
 * wave resolves, survivors push, and a champion clearing one changes the lane.
 * See `scripts/lane-probe.ts` for the measurement.
 */
export function spawnMinionWave(world: World, team: number): void {
    const start = baseZ(team);
    // Ranks trail *behind* the leader, against the marching direction.
    const rankStep = -forwardZ(team) * MINION_RANK_GAP;

    for (let i = 0; i < MINIONS_PER_WAVE; i++) {
        const kind = i < MINIONS_MELEE_PER_WAVE ? KIND_MINION : KIND_MINION_CASTER;
        const file = i % MINIONS_PER_RANK;
        const rank = Math.floor(i / MINIONS_PER_RANK);
        // Centre the rank on the lane: files sit at -1, 0, +1 spacings for three.
        const x = (file - (MINIONS_PER_RANK - 1) / 2) * MINION_FILE_GAP;
        spawnUnit(world, team, kind, MINION_STATS[kind].hp, x, start + rank * rankStep);
    }
}
