import { defineHandlers } from 'murow/netcode';
import type { Peer } from 'murow/netcode';
import { intents, Components } from '../shared';
import {
    canAct,
    isReady,
    positionOf,
    resolveAttack,
    resolveCleave,
    resolveDash,
    resolvePotion,
    startCooldown,
    type AbilityBroadcast,
    type HitReport,
} from './abilities';
import type { DealDamage } from './damage';
import type { Match } from './match';

/** Where a player's resolved ability outcome goes. */
export interface CombatEffects extends AbilityBroadcast {
    /**
     * A swing connected. Reported only to the peer that threw it, which is what
     * keeps hit feedback about *your* combat instead of about every minion
     * trading blows down the lane.
     */
    onHit(peer: Peer, hit: HitReport): void;
}

/**
 * Turns the ability intents into ability resolutions. The rules themselves live
 * in server/abilities.ts, shared with the bot; what's specific here is that a
 * *player* asked, so the swing is lag-compensated against what that player
 * could actually see, and the outcome is reported back to them.
 *
 * Targeting is validated rather than trusted: the client says what it aimed at,
 * and `resolveAttack` only honours it if it's a live, damageable enemy in
 * range. The cooldown is spent either way: a swing that connects with nothing
 * is a miss, not a free retry.
 */
export function createCombatHandlers(match: Match, deal: DealDamage, effects: CombatEffects) {
    return defineHandlers(intents, {
        attack: ({ aimX, aimZ }, ctx) => {
            if (match.over || !canAct(ctx.world, ctx.entity)) return;
            if (!isReady(ctx.world, ctx.entity, ctx.tick, 'attackTick')) return;
            startCooldown(ctx.world, ctx.entity, ctx.tick, 'attackTick');

            const hit = ctx.lagCompensated(() => resolveAttack(ctx.world, ctx.entity, deal, aimX, aimZ));
            if (hit !== null) effects.onHit(ctx.peer, hit);
        },

        cleave: (_payload, ctx) => {
            if (match.over || !canAct(ctx.world, ctx.entity)) return;
            if (!isReady(ctx.world, ctx.entity, ctx.tick, 'cleaveTick')) return;
            startCooldown(ctx.world, ctx.entity, ctx.tick, 'cleaveTick');

            const here = positionOf(ctx.world, ctx.entity);
            if (here !== null) {
                effects.onCleave(here.x, here.z, ctx.world.get(ctx.entity, Components.Team).id);
            }

            const hits = ctx.lagCompensated(() => resolveCleave(ctx.world, ctx.entity, deal));
            for (const hit of hits) effects.onHit(ctx.peer, hit);
        },

        // Neither of the two below is lag-compensated, and neither should be.
        // They target nobody but the caster, so there is no "what could this
        // player see" question to rewind for, only the caster's present state.
        potion: (_payload, ctx) => {
            if (match.over || !canAct(ctx.world, ctx.entity)) return;
            if (!isReady(ctx.world, ctx.entity, ctx.tick, 'potionTick')) return;
            if (!resolvePotion(ctx.world, ctx.entity, ctx.tick)) return;

            const here = positionOf(ctx.world, ctx.entity);
            if (here !== null) {
                effects.onHeal(here.x, here.z, ctx.world.get(ctx.entity, Components.Team).id);
            }
        },

        dash: ({ dx, dz }, ctx) => {
            if (match.over || !canAct(ctx.world, ctx.entity)) return;
            if (!isReady(ctx.world, ctx.entity, ctx.tick, 'dashTick')) return;

            const path = resolveDash(ctx.world, ctx.entity, ctx.tick, dx, dz);
            if (path === null) return;
            effects.onDash(path, ctx.world.get(ctx.entity, Components.Team).id);
        },
    });
}
