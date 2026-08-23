import type { Entity, World } from 'murow';
import { Components, KIND_BASE, KIND_CHAMPION, isStructure } from '../shared';
import type { Match } from './match';

/**
 * Applies damage and owns every consequence of something dying.
 *
 * Every damage source in the game: champion basic attack, champion cleave,
 * minion, tower: used to pass its own `onDeath` callback that re-derived the
 * same two rules: a dead base ends the match, a dead champion needs a respawn
 * scheduled. Three of the four call sites remembered only the half they cared
 * about, which is exactly the class of bug the `Match` flag was already
 * introduced to kill. One resolver, one place those rules live.
 */
export type DealDamage = (target: Entity, amount: number, attacker: Entity | null) => void;

/** Just enough of the loop's ticker for damage to stamp its timers. */
export interface TickSource {
    readonly tickCount: number;
}

export interface DamageListeners {
    /**
     * A champion died. `victimTeam` is passed in because the entity is already
     * gone by then, and `killer` is null when the blow came from something
     * with no owner worth crediting.
     */
    onChampionKilled(victim: Entity, victimTeam: number, killer: Entity | null): void;
    /** A tower or base fell. Reported for the kill feed; the rules are handled here. */
    onStructureDestroyed(kind: number, team: number): void;
}

/** Whether `target` is currently immune: a nexus still behind its towers. */
function isShielded(world: World, target: Entity): boolean {
    return world.has(target, Components.Shield)
        && world.get(target, Components.Shield).active === 1;
}

export function createDealDamage(
    world: World,
    match: Match,
    /** Current tick, so being hit can push the regeneration delay back. */
    clock: TickSource,
    listeners: DamageListeners,
): DealDamage {
    return function deal(target, amount, attacker) {
        if (!world.isAlive(target) || !world.has(target, Components.Health)) return;
        // A shielded nexus takes nothing at all. Swings still *happen*: the
        // attacker's cooldown is spent and the hit is reported, so the rule
        // reads as "this can't be hurt yet", not as the game dropping inputs.
        if (isShielded(world, target)) return;

        const remaining = Math.max(0, world.get(target, Components.Health).current - amount);
        world.update(target, Components.Health, { current: remaining });
        // Taking a hit restarts the out-of-combat clock, so nothing heals while
        // it's still being shot at.
        if (world.has(target, Components.Timers)) {
            world.update(target, Components.Timers, { damagedTick: clock.tickCount });
        }
        stampChampionAggro(world, clock, target, attacker);
        if (remaining > 0) return;

        // Read team/kind before despawning: the entity is gone afterwards.
        const team = world.has(target, Components.Team) ? world.get(target, Components.Team).id : -1;
        const kind = world.has(target, Components.Kind) ? world.get(target, Components.Kind).value : -1;
        world.despawn(target);

        if (isStructure(kind)) listeners.onStructureDestroyed(kind, team);
        if (kind === KIND_BASE) match.end(team);
        if (kind === KIND_CHAMPION) listeners.onChampionKilled(target, team, attacker);
    };
}

/**
 * Marks a champion that just attacked an enemy champion, so nearby enemy
 * towers switch to it (see `TOWER_CHAMPION_AGGRO_SEC` and server/systems.ts).
 *
 * Stamped here rather than in the ability handlers because *every* way a
 * champion can hurt another champion has to count: a cleave that catches
 * someone under their own tower is exactly as much of a dive as a basic
 * attack, and putting the stamp on one path and not the other is how a rule
 * like this quietly ends up half-implemented.
 */
function stampChampionAggro(
    world: World,
    clock: TickSource,
    target: Entity,
    attacker: Entity | null,
): void {
    if (attacker === null || !world.isAlive(attacker)) return;
    if (!world.has(attacker, Components.Timers)) return;
    if (!isChampion(world, target) || !isChampion(world, attacker)) return;
    world.update(attacker, Components.Timers, { aggroTick: clock.tickCount });
}

function isChampion(world: World, entity: Entity): boolean {
    return world.has(entity, Components.Kind)
        && world.get(entity, Components.Kind).value === KIND_CHAMPION;
}
