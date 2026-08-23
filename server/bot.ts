import type { Entity, World } from 'murow';
import {
    ATTACK_RANGE,
    BOT_CLEAVE_MIN_TARGETS,
    BOT_DECISION_INTERVAL_SEC,
    BOT_LEAD_DISTANCE,
    BOT_POTION_HP_FRACTION,
    BOT_REACTION_MAX_SEC,
    BOT_REACTION_MIN_SEC,
    BOT_REENGAGE_HP_FRACTION,
    BOT_RETREAT_HP_FRACTION,
    BOT_STRAFE_AMPLITUDE,
    BOT_STRUCTURE_STANDOFF,
    BOT_TOWER_SAFETY_MARGIN,
    CHAMPION_KINDS,
    CLEAVE_RANGE,
    Components,
    DASH_DISTANCE,
    KIND_TOWER,
    LANE_WIDTH_HALF,
    MINION_KINDS,
    TOWER_ATTACK_RANGE,
    baseZ,
    clamp,
    forwardZ,
    isMinion,
    isStructure,
    stepChampion,
} from '../shared';
import {
    canAct,
    isReady,
    positionOf,
    resolveAttack,
    resolveCleave,
    resolveDash,
    resolvePotion,
    type AbilityBroadcast,
    startCooldown,
} from './abilities';
import type { DealDamage } from './damage';
import type { Match } from './match';
import type { Player } from './roster';
import { findEnemiesInRange, findNearestEnemyInRange } from './targeting';

/**
 * A lane bot that plays by the players' rules.
 *
 * It has no privileged access to anything: it moves with `stepChampion` (the
 * same step the movement prediction uses) and swings through the same
 * `server/abilities.ts` functions the intent handlers call, so it is bound by
 * the same range, cooldowns and target priority. What makes it an opponent
 * rather than a script is *judgement*, and the habits below are the ones that
 * separate a human laner from a unit that walks forward until it dies:
 *
 *  - **It stays with its wave.** It won't push past the front of its own
 *    minions by more than `BOT_LEAD_DISTANCE`, because a champion alone in the
 *    lane is just a free kill.
 *  - **It walks at an objective, never past one.** Its advance is capped at
 *    the enemy's frontmost standing structure.
 *  - **It respects towers.** It keeps out of an enemy tower's range unless its
 *    own minions are in there soaking the shots.
 *  - **It gives up on fights it's losing.** Below `BOT_RETREAT_HP_FRACTION` it
 *    walks home, and it won't come back out until it's healthy again -
 *    hysteresis, so it doesn't oscillate on the threshold.
 *  - **It hesitates before swinging.** Its damage per hit is identical to a
 *    player's; what gave it away was rhythm, landing a hit on the exact tick
 *    every cooldown expired. `BOT_REACTION_*` costs it the fraction of a
 *    second a person spends noticing and clicking.
 *
 * It also re-reads the board on a fixed interval rather than every tick, and
 * wanders sideways while it walks, so it doesn't move with the tell-tale
 * instant, pixel-straight precision of a machine.
 */

/** How far out the bot looks for something worth lining up on. */
const PREY_SEARCH_RANGE = CLEAVE_RANGE * 2;
/** Frequency of the sideways wander, in radians per second. */
const STRAFE_FREQUENCY = 1.7;
/** Below this distance from its target the bot holds still rather than jittering. */
const ARRIVAL_EPSILON = 0.15;
/** How far in front of its own base the bot waits while recovering. */
const RETREAT_DEPTH = 2;

interface BotState {
    /** Seconds since the last re-plan. */
    sinceDecision: number;
    /** Where it currently wants to stand. */
    targetX: number;
    targetZ: number;
    /** True while walking home to recover; cleared only once healthy again. */
    retreating: boolean;
    /** Phase of the sideways wander, advanced with real time. */
    strafePhase: number;
    /**
     * Seconds of hesitation still owed before the next swing. Held topped up
     * while the attack is on cooldown, so it starts counting down the moment
     * the cooldown ends: see `fight`.
     */
    reaction: number;
}

export interface BotBrain {
    /**
     * Advances every bot by one tick.
     *
     * `bots` is the whole current roster of them, not a delta, which is what
     * lets the brain drop the state of any bot that has left without the
     * caller having to remember to tell it. A `forget(id)` that the lobby had
     * to call is one more thing to get wrong on every path that removes a
     * player, and there are several.
     */
    update(bots: readonly Player[], tick: number, deltaTime: number): void;
}

/** Fraction of max health remaining, or 1 when the entity has no Health. */
function healthFraction(world: World, entity: Entity): number {
    if (!world.has(entity, Components.Health)) return 1;
    const health = world.get(entity, Components.Health);
    return health.max > 0 ? health.current / health.max : 0;
}

export function createBotBrain(
    world: World,
    match: Match,
    deal: DealDamage,
    effects: AbilityBroadcast,
): BotBrain {
    const states = new Map<string, BotState>();

    function stateFor(bot: Player): BotState {
        let state = states.get(bot.id);
        if (state === undefined) {
            state = {
                sinceDecision: Number.POSITIVE_INFINITY, // decide on the first tick
                targetX: 0,
                targetZ: baseZ(bot.team),
                retreating: false,
                // Random phase so two bots never wander in lockstep.
                strafePhase: Math.random() * Math.PI * 2,
                reaction: 0,
            };
            states.set(bot.id, state);
        }
        return state;
    }

    /**
     * How deep into enemy territory a Z coordinate is, for this team. Lets the
     * rest of the reasoning be written once instead of mirrored per side.
     */
    function depth(team: number, z: number): number {
        return z * forwardZ(team);
    }

    /** Deepest friendly minion, in team-relative depth, or null if the wave is gone. */
    function frontlineDepth(team: number, self: Entity): number | null {
        let deepest: number | null = null;
        for (const e of world.query(Components.Position, Components.Team, Components.Kind)) {
            if (e === self) continue;
            if (!isMinion(world.get(e, Components.Kind).value)) continue;
            if (world.get(e, Components.Team).id !== team) continue;

            const d = depth(team, world.get(e, Components.Position).z);
            if (deepest === null || d > deepest) deepest = d;
        }
        return deepest;
    }

    /**
     * The first enemy structure still standing on this team's path: the thing
     * it should be walking at right now.
     *
     * Doubles as the hard limit on how far it may advance. Without it the bot
     * follows whichever of its minions has leaked deepest, and a straggler
     * that walks past the enemy base drags the bot onto the enemy *spawn
     * point*, where it farms respawns forever. Towers and bases both count, so
     * once the towers are down the base becomes the objective rather than the
     * bot being handed the whole enemy half of the map.
     */
    function nextEnemyStructure(
        team: number,
    ): { depth: number; x: number; z: number; isTower: boolean } | null {
        let best: { depth: number; x: number; z: number; isTower: boolean } | null = null;
        for (const e of world.query(Components.Position, Components.Team, Components.Kind)) {
            const kind = world.get(e, Components.Kind).value;
            if (!isStructure(kind)) continue;
            if (world.get(e, Components.Team).id === team) continue;

            const pos = world.get(e, Components.Position);
            const candidate = {
                depth: depth(team, pos.z),
                x: pos.x,
                z: pos.z,
                isTower: kind === KIND_TOWER,
            };
            if (best === null || candidate.depth < best.depth) best = candidate;
        }
        return best;
    }

    /** Whether this team has minions inside `tower`'s range to soak its shots. */
    function waveIsTanking(team: number, tower: { x: number; z: number }): boolean {
        for (const e of world.query(Components.Position, Components.Team, Components.Kind)) {
            if (!isMinion(world.get(e, Components.Kind).value)) continue;
            if (world.get(e, Components.Team).id !== team) continue;

            const pos = world.get(e, Components.Position);
            if (Math.hypot(pos.x - tower.x, pos.z - tower.z) <= TOWER_ATTACK_RANGE) return true;
        }
        return false;
    }

    /** Re-reads the board and picks a spot to stand. */
    function decide(bot: Player, state: BotState, self: Entity): void {
        const team = bot.team;
        const forward = forwardZ(team);
        const here = positionOf(world, self);
        if (here === null) return;

        // Hysteresis on the retreat decision: leaving at 35% but only returning
        // at 75% stops it from bouncing in and out of the fight.
        const hp = healthFraction(world, self);
        state.retreating = state.retreating
            ? hp < BOT_REENGAGE_HP_FRACTION
            : hp < BOT_RETREAT_HP_FRACTION;

        if (state.retreating) {
            state.targetX = 0;
            state.targetZ = baseZ(team) + forward * RETREAT_DEPTH;
            return;
        }

        // Advance with the wave, not ahead of it. With no wave left, hold where
        // we are rather than walking in alone.
        const frontline = frontlineDepth(team, self);
        let goalDepth = frontline !== null ? frontline + BOT_LEAD_DISTANCE : depth(team, here.z);

        const objective = nextEnemyStructure(team);
        if (objective !== null) {
            // Close enough to hit the objective, never past it.
            goalDepth = Math.min(goalDepth, objective.depth - BOT_STRUCTURE_STANDOFF);
            // And don't stand under a tower that isn't busy shooting our minions.
            if (objective.isTower && !waveIsTanking(team, objective)) {
                goalDepth = Math.min(
                    goalDepth,
                    objective.depth - (TOWER_ATTACK_RANGE + BOT_TOWER_SAFETY_MARGIN),
                );
            }
        }

        // Line up on whatever is worth hitting: an enemy champion first (a kill
        // is worth more than a minion), otherwise the nearest minion.
        const prey = findNearestEnemyInRange(world, self, PREY_SEARCH_RANGE, CHAMPION_KINDS)
            ?? findNearestEnemyInRange(world, self, PREY_SEARCH_RANGE, MINION_KINDS);
        const preyPos = prey === null ? null : positionOf(world, prey);

        state.targetX = preyPos === null ? 0 : preyPos.x;
        state.targetZ = goalDepth * forward;
    }

    /** Walks one tick toward the current target, wandering slightly as it goes. */
    function steer(state: BotState, self: Entity, deltaTime: number): void {
        const here = positionOf(world, self);
        if (here === null) return;

        state.strafePhase += deltaTime;
        const wanderX = Math.sin(state.strafePhase * STRAFE_FREQUENCY) * BOT_STRAFE_AMPLITUDE;
        const goalX = clamp(state.targetX + wanderX, -LANE_WIDTH_HALF, LANE_WIDTH_HALF);

        const dx = goalX - here.x;
        const dz = state.targetZ - here.z;
        const distance = Math.hypot(dx, dz);
        // Close enough: standing still beats vibrating around the target.
        if (distance < ARRIVAL_EPSILON) return;

        world.update(
            self,
            Components.Position,
            stepChampion(here.x, here.z, dx / distance, dz / distance, deltaTime),
        );
    }

    /** A fresh human-ish pause before the next swing. */
    function nextReaction(): number {
        return BOT_REACTION_MIN_SEC + Math.random() * (BOT_REACTION_MAX_SEC - BOT_REACTION_MIN_SEC);
    }

    /**
     * Spends whatever is off cooldown, on the same terms a player would, plus
     * a pause the player also pays.
     *
     * The pause is counted *after* the cooldown expires, not while it runs.
     * Running it in parallel was the obvious way to write this and did nothing
     * at all: a 0.3s hesitation inside a 1s cooldown still leaves one swing per
     * second, exactly the frame-perfect rhythm it was meant to break. Counted
     * afterwards it lands where it should: the bot's *rate* ends up below a
     * player who never misses a click, while its damage per hit stays
     * identical.
     */
    function fight(bot: Player, state: BotState, self: Entity, tick: number, deltaTime: number): void {
        // Drinking and dashing sit off the attack cooldown's critical path on
        // purpose: neither is a swing, and making them wait behind one would
        // have the bot sitting on them through the exact seconds they were
        // meant to cover.
        tryPotion(bot, self, tick);
        tryDash(bot, state, self, tick);

        if (!isReady(world, self, tick, 'attackTick')) {
            // Still winding up: hold a fresh reaction so the pause begins the
            // moment the cooldown ends.
            state.reaction = nextReaction();
            return;
        }
        if (state.reaction > 0) {
            state.reaction = Math.max(0, state.reaction - deltaTime);
            return;
        }

        if (tryCleave(bot, self, tick)) return;

        // Aims, like a player does: an enemy champion is worth more than a
        // minion, so it points at the champion whenever one is in reach. The
        // aim goes through the same resolution the `attack` intent uses, so the
        // bot is bound by the same range and hostility rules.
        const target = findNearestEnemyInRange(world, self, ATTACK_RANGE, CHAMPION_KINDS)
            ?? findNearestEnemyInRange(world, self, ATTACK_RANGE);
        if (target === null) return;
        const aim = positionOf(world, target);
        if (aim === null) return;

        startCooldown(world, self, tick, 'attackTick');
        resolveAttack(world, self, deal, aim.x, aim.z);
    }

    /**
     * Spends the dash, in the two situations a player would.
     *
     * Escaping takes priority over engaging: a bot that dashes onto a target it
     * cannot kill and then has no way out is worse than one that never dashes
     * at all. Both cases go through `resolveDash`, so the bot is bound by the
     * same distance and the same lane bounds as a player.
     */
    function tryDash(bot: Player, state: BotState, self: Entity, tick: number): void {
        if (!isReady(world, self, tick, 'dashTick')) return;

        const here = positionOf(world, self);
        if (here === null) return;
        const forward = forwardZ(bot.team);

        // Disengage: hurt, and something is close enough to keep hitting us.
        if (state.retreating) {
            const threat = findNearestEnemyInRange(world, self, ATTACK_RANGE + 1, CHAMPION_KINDS);
            if (threat !== null) {
                emitDash(bot, self, tick, 0, -forward);
                return;
            }
        }

        // Engage: healthy, and an enemy champion sits just outside reach.
        if (state.retreating || healthFraction(world, self) < BOT_REENGAGE_HP_FRACTION) return;
        const prey = findNearestEnemyInRange(world, self, DASH_DISTANCE + ATTACK_RANGE, CHAMPION_KINDS);
        if (prey === null) return;
        const preyPos = positionOf(world, prey);
        if (preyPos === null) return;

        const gap = Math.hypot(preyPos.x - here.x, preyPos.z - here.z);
        if (gap <= ATTACK_RANGE) return; // already in reach, no need to spend it
        emitDash(bot, self, tick, preyPos.x - here.x, preyPos.z - here.z);
    }

    function emitDash(bot: Player, self: Entity, tick: number, dx: number, dz: number): void {
        const path = resolveDash(world, self, tick, dx, dz);
        if (path !== null) effects.onDash(path, bot.team);
    }

    /**
     * Drinks once it is hurt enough to be worth it.
     *
     * The threshold sits *above* the retreat one deliberately: a potion is what
     * a laner spends to avoid having to walk home, so waiting until it has
     * already committed to retreating wastes it. `resolvePotion` refuses at
     * full health, so this can't burn the cooldown for nothing.
     */
    function tryPotion(bot: Player, self: Entity, tick: number): void {
        if (!isReady(world, self, tick, 'potionTick')) return;
        if (healthFraction(world, self) >= BOT_POTION_HP_FRACTION) return;
        if (!resolvePotion(world, self, tick)) return;

        const here = positionOf(world, self);
        if (here !== null) effects.onHeal(here.x, here.z, bot.team);
    }

    /** Spends the cleave if it would catch enough. Returns whether it fired. */
    function tryCleave(bot: Player, self: Entity, tick: number): boolean {
        if (!isReady(world, self, tick, 'cleaveTick')) return false;
        if (findEnemiesInRange(world, self, CLEAVE_RANGE).length < BOT_CLEAVE_MIN_TARGETS) return false;

        startCooldown(world, self, tick, 'cleaveTick');
        const here = positionOf(world, self);
        if (here !== null) effects.onCleave(here.x, here.z, bot.team);
        resolveCleave(world, self, deal);
        return true;
    }

    /** Drops the state of any bot that is no longer on the roster. */
    function pruneState(bots: readonly Player[]): void {
        if (states.size === bots.length) return;
        const live = new Set(bots.map((bot) => bot.id));
        for (const id of states.keys()) {
            if (!live.has(id)) states.delete(id);
        }
    }

    return {
        update(bots, tick, deltaTime) {
            pruneState(bots);
            if (match.over) return;

            for (const bot of bots) {
                const self = bot.entity;
                if (self === null || !canAct(world, self)) continue;

                const state = stateFor(bot);
                state.sinceDecision += deltaTime;
                if (state.sinceDecision >= BOT_DECISION_INTERVAL_SEC) {
                    state.sinceDecision = 0;
                    decide(bot, state, self);
                }

                steer(state, self, deltaTime);
                fight(bot, state, self, tick, deltaTime);
            }
        },
    };
}
