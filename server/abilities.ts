import type { Entity, World } from 'murow';
import {
    ATTACK_COOLDOWN_TICKS,
    ATTACK_DAMAGE,
    ATTACK_RANGE,
    CLEAVE_COOLDOWN_TICKS,
    CLEAVE_DAMAGE,
    CLEAVE_RANGE,
    Components,
    DASH_COOLDOWN_TICKS,
    DASH_DISTANCE,
    POTION_COOLDOWN_TICKS,
    forwardZ,
    moveChampion,
    normalize,
} from '../shared';
import { findEnemiesInRange, findEnemyNearestAim } from './targeting';
import type { DealDamage } from './damage';

/**
 * What a champion's abilities do, independent of who asked.
 *
 * Players reach these through an intent handler (server/combat.ts); the bot
 * calls them directly (server/bot.ts). Sharing the implementation is the
 * point: a bot that resolved its own attacks would quietly drift away from the
 * rules players are held to: different range, different cooldown, different
 * target priority, and every balance change would have to be made twice.
 */

/** The `Components.Timers` fields that gate an ability. */
export type CooldownField = 'attackTick' | 'cleaveTick' | 'potionTick' | 'dashTick';

const COOLDOWN_TICKS: Record<CooldownField, number> = {
    attackTick: ATTACK_COOLDOWN_TICKS,
    cleaveTick: CLEAVE_COOLDOWN_TICKS,
    potionTick: POTION_COOLDOWN_TICKS,
    dashTick: DASH_COOLDOWN_TICKS,
};

/** Where a hit landed, so the caller can tell the attacker about it. */
export interface HitReport {
    x: number;
    z: number;
    damage: number;
    lethal: boolean;
}

/**
 * The ability effects that have to reach *everyone*.
 *
 * A basic attack is inferable from the victim's health dropping, but a cleave
 * that catches nothing would otherwise be invisible to every player except the
 * caster, and a potion is something the *enemy* most needs to see: it is the
 * difference between committing to a kill and backing off. Bots need these and
 * nothing else, which is why they're separate from the peer-addressed
 * `CombatEffects`.
 */
export interface AbilityBroadcast {
    onCleave(x: number, z: number, team: number): void;
    onHeal(x: number, z: number, team: number): void;
    onDash(path: DashPath, team: number): void;
}

/** Whether the champion is alive and positioned, i.e. able to act at all. */
export function canAct(world: World, entity: Entity): boolean {
    return world.isAlive(entity) && world.has(entity, Components.Position);
}

/**
 * Whether `field`'s cooldown has elapsed. The server keeping its own copy of
 * every cooldown is what stops a modified client from spamming the intent -
 * the client's countdown only drives the hotbar.
 */
export function isReady(world: World, entity: Entity, tick: number, field: CooldownField): boolean {
    if (!world.has(entity, Components.Timers)) return false;

    const lastUsed = world.get(entity, Components.Timers)[field];
    // Zero means the ability has never been used, which is not the same as
    // having been used at tick 0. Without this the elapsed check reads
    // `tick - 0`, so nothing is available until the server has been running for
    // a full cooldown: on a fresh process that locked the potion out for its
    // first thirty seconds and the dash for its first twelve. The same
    // "zero is not a timestamp" rule applies to every field on `Timers`.
    if (lastUsed === 0) return true;
    return tick - lastUsed >= COOLDOWN_TICKS[field];
}

/** Starts the cooldown. Called the moment an ability commits, before it resolves. */
export function startCooldown(world: World, entity: Entity, tick: number, field: CooldownField): void {
    world.update(entity, Components.Timers, { [field]: tick });
}

/**
 * Single-target swing at whatever is closest to `[aimX, aimZ]` and in range.
 *
 * Honouring the aim is what makes pointing at something mean anything:
 * resolving to the nearest enemy regardless landed the swing on whichever
 * minion happened to be half a metre closer than the champion the player was
 * lined up on. Range and hostility are still decided here, not by the caller.
 */
export function resolveAttack(
    world: World,
    entity: Entity,
    deal: DealDamage,
    aimX: number,
    aimZ: number,
): HitReport | null {
    const target = findEnemyNearestAim(world, entity, ATTACK_RANGE, aimX, aimZ);
    if (target === null) return null;
    return damageAndReport(world, target, ATTACK_DAMAGE, entity, deal);
}

/** Hits every enemy in the cleave radius. Returns one report per victim. */
export function resolveCleave(world: World, entity: Entity, deal: DealDamage): HitReport[] {
    // `findEnemiesInRange` returns a fresh array on purpose: the cleave is the
    // one ability that can kill several entities in a single resolution, and
    // `deal` despawns what it kills.
    const reports: HitReport[] = [];
    for (const target of findEnemiesInRange(world, entity, CLEAVE_RANGE)) {
        const report = damageAndReport(world, target, CLEAVE_DAMAGE, entity, deal);
        if (report !== null) reports.push(report);
    }
    return reports;
}

/**
 * Where `entity` is standing, or null if it isn't in the world.
 *
 * Copied out to plain numbers immediately: `world.get()` returns one object per
 * component type, reused across every call, so holding the result across
 * another read of the same component silently aliases it.
 */
export function positionOf(world: World, entity: Entity): { x: number; z: number } | null {
    if (!world.has(entity, Components.Position)) return null;
    const pos = world.get(entity, Components.Position);
    return { x: pos.x, z: pos.z };
}

/**
 * Starts the potion's heal-over-time. The healing itself is applied by the
 * regen system (server/systems.ts), which already runs on the coarse schedule
 * integer health needs: all this has to do is stamp when it began.
 *
 * Returns false when the champion is already at full health, so a full-health
 * misclick doesn't burn a 30-second cooldown for nothing.
 */
export function resolvePotion(world: World, entity: Entity, tick: number): boolean {
    if (!world.has(entity, Components.Health) || !world.has(entity, Components.Timers)) return false;

    const health = world.get(entity, Components.Health);
    if (health.current >= health.max || health.current <= 0) return false;

    startCooldown(world, entity, tick, 'potionTick');
    return true;
}

/** Where a dash started and ended, so the caller can broadcast the trail. */
export interface DashPath {
    fromX: number;
    fromZ: number;
    toX: number;
    toZ: number;
}

/** Below this displacement a dash is treated as blocked and refused. */
const MIN_DASH_TRAVEL = 0.2;

/**
 * Displaces the champion `DASH_DISTANCE` along `[dx, dz]`, bounded by the same
 * lane clamp ordinary movement uses. A zero-length direction falls back to the
 * team's forward, so a dash from a standstill goes somewhere useful.
 *
 * Returns null when the champion would not actually move, which happens facing
 * a lane boundary. Refusing costs nothing; the alternative spends a twelve
 * second cooldown on a no-op.
 *
 * Collision is not consulted. `resolveCollisions` runs at the end of the tick
 * and pushes the champion clear of anything it landed inside, which is what
 * lets a dash cross a minion wall without needing a swept test.
 */
export function resolveDash(
    world: World,
    entity: Entity,
    tick: number,
    dx: number,
    dz: number,
): DashPath | null {
    const here = positionOf(world, entity);
    if (here === null || !world.has(entity, Components.Team)) return null;

    const team = world.get(entity, Components.Team).id;
    const forward = normalize(dx, dz) ?? { dx: 0, dz: forwardZ(team) };
    const target = moveChampion(here.x, here.z, forward.dx, forward.dz, DASH_DISTANCE);
    if (Math.hypot(target.x - here.x, target.z - here.z) < MIN_DASH_TRAVEL) return null;

    world.update(entity, Components.Position, target);
    startCooldown(world, entity, tick, 'dashTick');
    return { fromX: here.x, fromZ: here.z, toX: target.x, toZ: target.z };
}

/** Applies damage and captures where it landed, before the victim can despawn. */
function damageAndReport(
    world: World,
    target: Entity,
    damage: number,
    attacker: Entity,
    deal: DealDamage,
): HitReport | null {
    if (!world.has(target, Components.Position) || !world.has(target, Components.Health)) return null;

    // Read the position out *before* dealing damage: a killing blow despawns
    // the target, and there is nothing left to ask afterwards.
    const pos = world.get(target, Components.Position);
    const x = pos.x;
    const z = pos.z;
    const before = world.get(target, Components.Health).current;

    deal(target, damage, attacker);

    // What actually landed, not what was requested. The two differ when the
    // target was already low (an overkill would otherwise report the full
    // swing), and reading it back is also what keeps the report honest if a
    // rule ever soaks part of a hit.
    const after = world.isAlive(target) ? world.get(target, Components.Health).current : 0;
    const dealt = Math.max(0, before - after);
    if (dealt === 0) return null;

    return { x, z, damage: dealt, lethal: !world.isAlive(target) };
}
