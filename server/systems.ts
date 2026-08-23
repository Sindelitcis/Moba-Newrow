import type { Entity, World } from 'murow';
import type { Arena, MinionStats } from '../shared';
import {
    ATTACK_COOLDOWN_TICKS,
    CHAMPION_BASE_REGEN_MULTIPLIER,
    CHAMPION_BASE_REGEN_RADIUS,
    CHAMPION_KINDS,
    CHAMPION_REGEN_DELAY_SEC,
    CHAMPION_REGEN_PER_SEC,
    Components,
    KIND_BASE,
    KIND_CHAMPION,
    KIND_TOWER,
    LANE_HALF,
    LANE_OVERRUN,
    MINION_KINDS,
    MINION_SPAWN_INTERVAL_SEC,
    MINION_STATS,
    NEXUS_REQUIRES_TOWERS_DOWN,
    POTION_DURATION_SEC,
    POTION_HEAL_TOTAL,
    REGEN_INTERVAL_SEC,
    STRUCTURE_KINDS,
    TEAMS,
    TICK_RATE,
    TOWER_ATTACK_COOLDOWN_TICKS,
    TOWER_ATTACK_DAMAGE,
    TOWER_ATTACK_RANGE,
    TOWER_CHAMPION_AGGRO_SEC,
    baseZ,
    forwardZ,
    isMinion,
} from '../shared';
import { spawnMinionWave } from './spawn';
import { findEnemiesInRange, findNearestEnemyInRange } from './targeting';
import type { DealDamage } from './damage';
import { resolveCollisions } from './collision';
import type { Match } from './match';

/**
 * Minion target priority: enemy minions first (lane clear), then champions (a
 * soft poke, not a real duel), and structures only once nothing else is around
 * to fight. Which of the attacker's three damage numbers applies comes from
 * its own stat line, so the melee and caster ranks share one rule and differ
 * only in data.
 */
const MINION_PRIORITY: readonly {
    kinds: readonly number[];
    damage(stats: MinionStats): number;
}[] = [
    { kinds: MINION_KINDS, damage: (s) => s.vsMinion },
    { kinds: CHAMPION_KINDS, damage: (s) => s.vsChampion },
    { kinds: STRUCTURE_KINDS, damage: (s) => s.vsStructure },
];

export interface SystemListeners {
    /**
     * A nexus just lost the last tower protecting it. Purely an announcement -
     * the rule itself is the `Shield` component this system maintains.
     */
    onNexusExposed(team: number): void;
}

/**
 * Every entity that can attack and matches `accepts`, as a snapshot array.
 *
 * Snapshotting matters: dealing damage can despawn entities that also match
 * the query, and `world.query` hands back a cached buffer that despawn mutates
 * underneath the iteration.
 */
function attackers(world: World, accepts: (kind: number) => boolean): Entity[] {
    const found: Entity[] = [];
    for (const e of world.query(Components.Position, Components.Team, Components.Kind, Components.Timers)) {
        if (accepts(world.get(e, Components.Kind).value)) found.push(e);
    }
    return found;
}

/**
 * Wires the tick-driven server systems that aren't intent-triggered: minion
 * wave spawning, minion movement and combat, tower auto-attack, and the nexus
 * shield. All of it pauses while `match.over` is true and resumes by itself
 * once the arena is rebuilt: the schedules stay registered across a reset.
 */
export function registerGameSystems(
    arena: Arena<'server-timeout'>,
    match: Match,
    deal: DealDamage,
    listeners: SystemListeners,
): void {
    const { world, loop } = arena;

    loop.every(MINION_SPAWN_INTERVAL_SEC).seconds(() => {
        if (match.over) return;
        for (const team of TEAMS) spawnMinionWave(world, team);
    });

    loop.every(REGEN_INTERVAL_SEC).seconds(() => {
        if (!match.over) regenerateChampions(world, loop.ticker.tickCount);
    });

    loop.events.on('tick', ({ deltaTime, tick }) => {
        if (match.over) return;

        // Shields first: a nexus that lost its last tower on the previous tick
        // must be hittable *this* tick, not one tick later.
        updateNexusShields(world, listeners);
        updateMinions(world, deal, deltaTime, tick);
        updateTowers(world, deal, tick);

        // Push overlapping units apart last, after everyone has tried to move
        // this tick: a minion shoved off a blocked lane just tries to advance
        // again next tick, which reads as routing around whatever blocked it
        // instead of stacking on top of it.
        resolveCollisions(world);
    });
}

/**
 * Keeps each nexus's `Shield` in step with whether its team still has a tower
 * standing, and announces the moment one opens up.
 *
 * A recompute per tick rather than a hook on tower death: it is six entities
 * of work, it cannot drift out of sync with the world the way a cached flag
 * can, and it is automatically correct across a match reset without the reset
 * having to remember anything.
 */
function updateNexusShields(world: World, listeners: SystemListeners): void {
    if (!NEXUS_REQUIRES_TOWERS_DOWN) return;

    const towersStanding = new Map<number, boolean>(TEAMS.map((team) => [team, false]));
    const nexuses: Entity[] = [];

    for (const e of world.query(Components.Team, Components.Kind, Components.Shield)) {
        const kind = world.get(e, Components.Kind).value;
        const team = world.get(e, Components.Team).id;
        if (kind === KIND_TOWER) towersStanding.set(team, true);
        else if (kind === KIND_BASE) nexuses.push(e);
    }

    for (const nexus of nexuses) {
        const team = world.get(nexus, Components.Team).id;
        const shielded = towersStanding.get(team) === true ? 1 : 0;
        if (world.get(nexus, Components.Shield).active === shielded) continue;

        world.update(nexus, Components.Shield, { active: shielded });
        if (shielded === 0) listeners.onNexusExposed(team);
    }
}

function updateMinions(world: World, deal: DealDamage, deltaTime: number, tick: number): void {
    for (const e of attackers(world, isMinion)) {
        if (!world.isAlive(e)) continue;

        const stats = MINION_STATS[world.get(e, Components.Kind).value];
        // Minions swing on the same 1-attack/sec cadence as a champion's basic
        // attack rather than dealing damage every single tick.
        const canAttack = tick - world.get(e, Components.Timers).attackTick >= ATTACK_COOLDOWN_TICKS;

        let engaged = false;
        for (const { kinds, damage } of MINION_PRIORITY) {
            const target = findNearestEnemyInRange(world, e, stats.attackRange, kinds);
            if (target === null) continue;
            // Being engaged holds position regardless of whether this
            // particular tick is the one that actually lands a hit.
            engaged = true;
            if (canAttack) {
                world.update(e, Components.Timers, { attackTick: tick });
                deal(target, damage(stats), e);
            }
            break;
        }
        if (engaged) continue;

        // Extract to primitives before the Team read: `world.get()` returns
        // one object reused across every call for a given component type.
        const pos = world.get(e, Components.Position);
        const x = pos.x;
        const z = pos.z;

        const advanced = z + forwardZ(world.get(e, Components.Team).id) * stats.speed * deltaTime;
        world.update(e, Components.Position, { x, z: advanced });

        // Missed everything and walked off the map: clean up.
        if (Math.abs(advanced) > LANE_HALF + LANE_OVERRUN) world.despawn(e);
    }
}

/**
 * Champion healing: out-of-combat regeneration (quadrupled inside their own
 * base's radius) plus any active potion.
 *
 * Runs on its own coarse schedule rather than per tick because Health is an
 * integer: 0.2 HP twenty times a second truncates away to zero, 2 HP twice a
 * second doesn't. The potion rides the same schedule for exactly that reason -
 * it is a heal-over-time, and this is already the place that knows how to add
 * fractional health without losing it to rounding.
 *
 * The two sources stack, and only one of them is gated on being out of combat.
 * That is the whole point of the potion (see `POTION_HEAL_TOTAL`): regen
 * already covers walking home, so healing *through* damage is the only thing it
 * could add that regen doesn't.
 */
function regenerateChampions(world: World, tick: number): void {
    const combatDelayTicks = CHAMPION_REGEN_DELAY_SEC * TICK_RATE;
    const potionTicks = POTION_DURATION_SEC * TICK_RATE;
    const potionPerSecond = POTION_HEAL_TOTAL / POTION_DURATION_SEC;

    for (const e of world.query(Components.Position, Components.Team, Components.Kind, Components.Timers, Components.Health)) {
        if (world.get(e, Components.Kind).value !== KIND_CHAMPION) continue;

        const health = world.get(e, Components.Health);
        const current = health.current;
        const max = health.max;
        if (current <= 0 || current >= max) continue;

        const timers = world.get(e, Components.Timers);
        const outOfCombat = tick - timers.damagedTick >= combatDelayTicks;
        // Zero means "never drunk", not "drunk at tick 0": at server start
        // `tick` is 0 too, and without this guard every champion would spawn
        // mid-potion.
        const potionActive = timers.potionTick > 0 && tick - timers.potionTick < potionTicks;
        if (!outOfCombat && !potionActive) continue;

        const team = world.get(e, Components.Team).id;
        const pos = world.get(e, Components.Position);
        const atHome = Math.hypot(pos.x, pos.z - baseZ(team)) <= CHAMPION_BASE_REGEN_RADIUS;

        let perSecond = potionActive ? potionPerSecond : 0;
        if (outOfCombat) {
            perSecond += CHAMPION_REGEN_PER_SEC * (atHome ? CHAMPION_BASE_REGEN_MULTIPLIER : 1);
        }

        world.update(e, Components.Health, {
            current: Math.min(max, current + Math.round(perSecond * REGEN_INTERVAL_SEC)),
        });
    }
}

/**
 * Tower auto-attack, in standard MOBA aggro order:
 *
 *  1. a champion that has just attacked one of ours inside this tower's range
 *     (see `TOWER_CHAMPION_AGGRO_SEC`): the rule that makes diving cost
 *     something even when there are minions around to distract the tower;
 *  2. otherwise the nearest enemy minion;
 *  3. otherwise the nearest enemy champion.
 *
 * Towers never shoot other structures.
 */
function updateTowers(world: World, deal: DealDamage, tick: number): void {
    const aggroTicks = TOWER_CHAMPION_AGGRO_SEC * TICK_RATE;

    for (const e of attackers(world, (kind) => kind === KIND_TOWER)) {
        if (!world.isAlive(e)) continue;
        if (tick - world.get(e, Components.Timers).attackTick < TOWER_ATTACK_COOLDOWN_TICKS) continue;

        const target =
            findDiver(world, e, tick, aggroTicks) ??
            findNearestEnemyInRange(world, e, TOWER_ATTACK_RANGE, MINION_KINDS) ??
            findNearestEnemyInRange(world, e, TOWER_ATTACK_RANGE, CHAMPION_KINDS);
        if (target === null) continue;

        world.update(e, Components.Timers, { attackTick: tick });
        deal(target, TOWER_ATTACK_DAMAGE, e);
    }
}

/** The enemy champion in range that most recently opened on one of ours. */
function findDiver(world: World, tower: Entity, tick: number, aggroTicks: number): Entity | null {
    let best: Entity | null = null;
    let mostRecent = -1;

    for (const candidate of findEnemiesInRange(world, tower, TOWER_ATTACK_RANGE, CHAMPION_KINDS)) {
        if (!world.has(candidate, Components.Timers)) continue;
        const stamp = world.get(candidate, Components.Timers).aggroTick;
        if (stamp === 0 || tick - stamp > aggroTicks) continue;
        if (stamp <= mostRecent) continue;
        mostRecent = stamp;
        best = candidate;
    }

    return best;
}
