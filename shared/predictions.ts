import { definePredictions } from 'murow/netcode';
import { intents } from './protocol';
import { Components } from './components';
import { stepChampion } from './movement';

/**
 * Movement prediction. Runs identically on the server (authoritative) and
 * on each client (predicted) so the same WASD press produces the same
 * world state on both sides. Only champions ever receive a `move` intent
 * (towers/bases/minions aren't peer-assigned), so no Kind check needed.
 *
 * Deterministic: no Math.random, no Date.now, no module-level state. The step
 * itself lives in movement.ts, shared with the bot: an AI that moved by
 * different rules than the players would be playing a different game.
 */
export const predictions = definePredictions(intents, {
    move: ({ dx, dz }, ctx) => {
        if (!ctx.world.has(ctx.entity, Components.Position)) return;

        const pos = ctx.fields(Components.Position);
        const next = stepChampion(pos.x[ctx.entity], pos.z[ctx.entity], dx, dz, ctx.deltaTime);

        pos.x[ctx.entity] = next.x;
        pos.z[ctx.entity] = next.z;
    },
});
