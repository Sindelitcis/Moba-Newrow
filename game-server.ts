import { Transports } from 'murow';
import { GameServer } from 'murow/netcode';
import {
    Arena,
    GAME_SERVER_PORT,
    TICK_RATE,
    WS_PATH,
    intents,
    predictions,
    rpcs,
} from './shared';
import { createBotBrain } from './server/bot';
import { createCombatHandlers, type CombatEffects } from './server/combat';
import { createDealDamage } from './server/damage';
import { createMatchHost } from './server/host';
import { spawnStructures } from './server/spawn';
import { registerGameSystems } from './server/systems';

/**
 * Authoritative game server: the composition root and nothing else.
 *
 * Runs as its own Bun process, separate from the Newstack page server
 * (server.ts): Newstack's CLI spawns its server under plain Node, and Murow's
 * build output relies on Bun's more lenient ESM resolution, so the two can't
 * share a runtime. The Newstack page opens a WebSocket to this process's port
 * to actually play.
 *
 * The rules live under `server/`: `host` (who is playing, respawns, the score,
 * the match cycle), `spawn`, `targeting`, `damage`, `abilities` (what an
 * attack or cleave does), `combat` (the intent handlers that call them),
 * `systems` (tick-driven minions, towers, nexus shields and regen),
 * `collision`, `bot`, `roster` and `scoreboard`.
 */
const PORT = Number(process.env.GAME_PORT) || GAME_SERVER_PORT;

const arena = new Arena('server-timeout');
spawnStructures(arena.world);

const server = new GameServer({
    loop: arena.loop,
    world: arena.world,
    transport: Transports.BunWsServer.create(PORT, { path: WS_PATH }),
    protocol: { intents, rpcs },
    snapshot: { rate: TICK_RATE },
});
server.use(predictions);

const host = createMatchHost({ arena, server });
const deal = createDealDamage(arena.world, host.match, arena.loop.ticker, host.damage);

const combatEffects: CombatEffects = {
    onCleave: (x, z, team) => server.broadcastRpc('cleaveFx', { x, z, team }),
    onHeal: (x, z, team) => server.broadcastRpc('healFx', { x, z, team }),
    onDash: (path, team) => server.broadcastRpc('dashFx', { ...path, team }),
    // Only the peer that swung hears about it. Bots go through the same
    // resolution but have no peer, so they simply report to nobody.
    onHit: (peer, hit) => server.sendRpc(peer, 'hitLanded', {
        x: hit.x,
        z: hit.z,
        damage: hit.damage,
        lethal: hit.lethal ? 1 : 0,
    }),
};

server.use(createCombatHandlers(host.match, deal, combatEffects));

// Registered before the game systems so bots move within the same tick they
// decide, and the collision pass at the end of those systems still gets the
// last word on where everyone actually ends up.
const botBrain = createBotBrain(arena.world, host.match, deal, combatEffects);
arena.loop.events.on('tick', ({ tick, deltaTime }) => {
    botBrain.update(host.bots(), tick, deltaTime);
});
registerGameSystems(arena, host.match, deal, host.systems);

server.on('connection', ({ peer }) => host.connect(peer));
server.on('rpc', ({ peer, name, payload }) => host.rpc(peer, name, payload));
server.on('disconnection', ({ peer, reason }) => host.disconnect(peer, reason));
server.on('error', ({ error, context }) => {
    console.error(`[server] error in ${context}:`, error);
});

console.log(`[server] listening on ws://localhost:${PORT}${WS_PATH}`);
arena.loop.start();
