/**
 * Headless end-to-end check of the authoritative server.
 *
 * Connects real `GameClient`s over a real WebSocket and asserts the rules that
 * can't be seen from a type-check and are tedious to confirm by eye: most
 * importantly that "forward" advances *both* teams toward the enemy, which is
 * the bug that had team A playing the map backwards.
 *
 * Start `bun run game-server` first, then: `bun run smoke`
 *
 * It plays as an extra pair of peers, so it takes real spawn slots: run it
 * against an otherwise empty server (it checks, and stops with an explanation
 * rather than reporting failures that are really someone else's browser tab).
 */
import { Transports, type Entity } from 'murow';
import { GameClient } from 'murow/netcode';
import {
    ATTACK_RANGE,
    Arena,
    Components,
    DASH_DISTANCE,
    GAME_SERVER_PORT,
    type Intents,
    KIND_BASE,
    KIND_CHAMPION,
    KIND_MINION,
    KIND_MINION_CASTER,
    MATCH_RESET_SECONDS,
    MINION_STATS,
    NEXUS_REQUIRES_TOWERS_DOWN,
    PLAYERS_PER_TEAM,
    type Rpcs,
    TICK_RATE,
    TOWER_ATTACK_DAMAGE,
    WS_PATH,
    baseZ,
    forwardZ,
    intents,
    predictions,
    rpcs,
} from '../shared';

const SERVER_URL = `ws://localhost:${GAME_SERVER_PORT}${WS_PATH}`;
const results: string[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RpcRecord {
    name: string;
    payload: Record<string, number>;
}

interface Harness {
    client: GameClient<Intents, Rpcs>;
    arena: Arena<'server-timeout'>;
    entity: Entity | null;
    team: number | null;
    rpcLog: RpcRecord[];
    close(): void;
}

async function connect(): Promise<Harness> {
    const arena = new Arena('server-timeout');
    // Construct the transport around a socket that is still CONNECTING and wire
    // GameClient to it synchronously. `BunWsClient.connect()` resolves on
    // *open*, and the adapter drops any frame that lands before `onMessage` is
    // registered: the server's MSG_ASSIGN_ENTITY goes out the instant the peer
    // connects, so awaiting first loses it. The browser transport has no such
    // window (its socket is created and wired in the same task).
    const socket = new WebSocket(SERVER_URL);
    const opened = new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
    const transport = new Transports.BunWsClient(socket as never);
    const client = new GameClient({
        world: arena.world,
        loop: arena.loop,
        transport,
        protocol: { intents, rpcs },
        strategy: { kind: 'snapshot-interpolation', delay: 100 },
    });
    client.use(predictions);

    const harness: Harness = {
        client,
        arena,
        entity: null,
        team: null,
        rpcLog: [],
        close: () => {
            arena.loop.stop();
            transport.close();
        },
    };

    client.on('assigned', ({ entity }) => {
        harness.entity = entity;
        harness.team = arena.world.has(entity, Components.Team)
            ? arena.world.get(entity, Components.Team).id
            : null;
    });
    // Same lesson the real client learned: entity ids are recycled immediately,
    // so a champion id held past its despawn can end up naming a live minion.
    // `null` is the only honest value for "dead, waiting to respawn".
    client.on('despawn', ({ entity }) => {
        if (entity === harness.entity) harness.entity = null;
    });
    client.on('rpc', ({ name, payload }) => {
        harness.rpcLog.push({ name, payload: payload as Record<string, number> });
    });
    client.on('error', ({ error, context }) => console.error('  [client error]', context, error.message));

    await opened;
    arena.loop.start();
    return harness;
}

function positionOf(h: Harness): { x: number; z: number } | null {
    if (h.entity === null || !h.arena.world.has(h.entity, Components.Position)) return null;
    const pos = h.arena.world.get(h.entity, Components.Position);
    return { x: pos.x, z: pos.z };
}

/** Every entity of `kind` currently in `h`'s view. */
function entitiesOfKind(h: Harness, kind: number): Entity[] {
    const found: Entity[] = [];
    for (const e of h.arena.world.query(Components.Kind, Components.Position)) {
        if (h.arena.world.get(e, Components.Kind).value === kind) found.push(e);
    }
    return found;
}

function countKind(h: Harness, kind: number): number {
    return entitiesOfKind(h, kind).length;
}

/** `h`'s champion's health, or null while it has none. */
function healthOf(h: Harness): { current: number; max: number } | null {
    if (h.entity === null || !h.arena.world.has(h.entity, Components.Health)) return null;
    const health = h.arena.world.get(h.entity, Components.Health);
    return { current: health.current, max: health.max };
}

function zOf(h: Harness, entity: Entity): number | null {
    if (!h.arena.world.has(entity, Components.Position)) return null;
    return h.arena.world.get(entity, Components.Position).z;
}

/** Enemies within `range` of `h`'s champion, with their positions and distance. */
function enemiesInRange(h: Harness, range: number): { entity: Entity; x: number; z: number; dist: number }[] {
    const self = positionOf(h);
    if (self === null || h.team === null) return [];

    const found: { entity: Entity; x: number; z: number; dist: number }[] = [];
    for (const e of h.arena.world.query(Components.Position, Components.Team, Components.Health)) {
        if (e === h.entity) continue;
        if (h.arena.world.get(e, Components.Team).id === h.team) continue;

        const pos = h.arena.world.get(e, Components.Position);
        const x = pos.x;
        const z = pos.z;
        const dist = Math.hypot(x - self.x, z - self.z);
        if (dist <= range) found.push({ entity: e, x, z, dist });
    }
    return found;
}

/**
 * Waits for the next RPC named `name`, up to `timeoutMs`.
 *
 * Anything the server sends on a schedule rather than in reply to something -
 * the match clock, for one: lands at an offset this test has no control over,
 * so "sleep a bit and look" is a coin flip. Wait for the thing itself.
 */
async function waitForRpc(h: Harness, name: string, timeoutMs = 4000): Promise<RpcRecord | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = h.rpcLog.find((r) => r.name === name);
        if (found !== undefined) return found;
        await sleep(100);
    }
    return null;
}

/**
 * Waits until `h` has a live champion again, up to `timeoutMs`. Returns whether
 * it got one: the respawn wait scales with how often you have died, so this
 * can't just sleep a fixed number of seconds.
 */
async function waitForChampion(h: Harness, timeoutMs = 25_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (h.entity !== null && h.arena.world.isAlive(h.entity) && positionOf(h) !== null) return true;
        await sleep(250);
    }
    return false;
}

/** Walks `h` along the lane for `seconds`, toward the enemy or back home. */
async function walk(h: Harness, seconds: number, direction: 1 | -1): Promise<void> {
    if (h.team === null) return;
    const dz = forwardZ(h.team) * direction;
    const steps = Math.round(seconds * TICK_RATE);
    for (let i = 0; i < steps; i++) {
        h.client.sendIntent('move', { dx: 0, dz });
        await sleep(1000 / TICK_RATE);
    }
}

/**
 * Walks `h` into the enemy wave until something hurts it, then straight back
 * out again. Returns whether it took damage and survived to tell the tale.
 *
 * The retreat is not optional: standing in a wave that is actively killing you
 * while a test sends an ability and waits for the reply is a race that
 * eventually loses, and a champion that dies mid-check reads as the ability
 * being broken.
 */
async function skirmish(h: Harness, timeoutMs = 8000): Promise<boolean> {
    if (h.team === null) return false;
    const forward = forwardZ(h.team);
    const deadline = Date.now() + timeoutMs;

    let tookDamage = false;
    while (Date.now() < deadline && !tookDamage) {
        const health = healthOf(h);
        if (health === null) return false; // died on the way in
        tookDamage = health.current < health.max;
        h.client.sendIntent('move', { dx: 0, dz: forward });
        await sleep(1000 / TICK_RATE);
    }
    if (!tookDamage) return false;

    // Back well out of reach: three seconds at MOVE_SPEED clears the wave, the
    // casters' range and the tower's. Regen is gated behind several seconds out
    // of combat, so the champion is still hurt when it gets there.
    await walk(h, 3, -1);
    return healthOf(h) !== null;
}

/**
 * Seats per team, as the server last reported them.
 *
 * Read off the `score` RPC rather than counted from the champions on the board,
 * which is what a roster question actually needs: a champion that just died is
 * gone from the world for the several seconds its respawn takes, while its seat
 * is still very much taken. Counting entities made every team-size check flap
 * whenever a bot happened to be dead at the moment it was sampled.
 *
 * The server broadcasts scores on every roster change, so the newest one is
 * always current.
 */
function rosterSizes(h: Harness): [number, number] {
    for (let i = h.rpcLog.length - 1; i >= 0; i--) {
        const record = h.rpcLog[i];
        if (record.name === 'score') return [record.payload.sizeA, record.payload.sizeB];
    }
    return [0, 0];
}

const a = await connect();
const b = await connect();
await sleep(900);

// Anything already on the board is somebody else's session: a leftover browser
// tab, another run. Every check below reasons about roster sizes and who is in
// range, so a shared arena produces confident nonsense. Bail early and say so
// rather than reporting failures that aren't real.
const preexisting = countKind(a, KIND_CHAMPION) - 2;
if (preexisting > 0) {
    console.log(`\nSERVER NOT EMPTY: ${preexisting} champion(s) already in the arena.`);
    console.log('Close other clients (browser tabs included) and restart the game server.');
    process.exit(2);
}

check('two peers get assigned champions', a.entity !== null && b.entity !== null,
    `a=${a.entity} b=${b.entity}`);
check('peers land on opposite teams', a.team !== b.team, `a=team${a.team} b=team${b.team}`);

// Behind its own base, not in front: an attacker hitting the nexus stands in
// front of it, and respawning into that spot is a spawn-camp by construction.
const startA = positionOf(a);
check('champion spawns behind its own base',
    startA !== null && Math.abs(startA.z) > Math.abs(baseZ(a.team!)),
    `z=${startA?.z.toFixed(2)} baseZ=${baseZ(a.team!)}`);

check('score RPC arrives on connect', a.rpcLog.some((r) => r.name === 'score'),
    JSON.stringify(a.rpcLog.find((r) => r.name === 'score')?.payload));

// The match clock is broadcast, not derived client-side, so a player who joins
// late sees the same time as everyone else.
{
    const clock = await waitForRpc(a, 'clock');
    check('the match clock is broadcast', clock !== null, JSON.stringify(clock?.payload));
}

// --- "W" must move toward the enemy base, for BOTH teams.
for (const h of [a, b]) {
    const before = positionOf(h)!;
    const sign = forwardZ(h.team!);
    for (let i = 0; i < 12; i++) {
        h.client.sendIntent('move', { dx: 0, dz: sign });
        await sleep(1000 / TICK_RATE);
    }
    await sleep(300);
    const after = positionOf(h)!;
    const travelled = (after.z - before.z) * sign;
    check(`team ${h.team}: forward input advances toward the enemy`, travelled > 0.3,
        `z ${before.z.toFixed(2)} -> ${after.z.toFixed(2)} (forwardZ=${sign})`);
}

// --- Towers must not delete a minion per shot; that was the whole point of the
// rebalance, and it's a pure numbers relationship worth pinning down.
for (const kind of [KIND_MINION, KIND_MINION_CASTER]) {
    check(`a tower shot cannot one-shot a ${kind === KIND_MINION ? 'melee' : 'caster'} minion`,
        TOWER_ATTACK_DAMAGE < MINION_STATS[kind].hp,
        `${TOWER_ATTACK_DAMAGE} damage vs ${MINION_STATS[kind].hp} HP`);
}
check('casters out-range the melee rank they hide behind',
    MINION_STATS[KIND_MINION_CASTER].attackRange > MINION_STATS[KIND_MINION].attackRange,
    `${MINION_STATS[KIND_MINION_CASTER].attackRange} vs ${MINION_STATS[KIND_MINION].attackRange}`);

// --- The nexus is behind its towers: shielded, and untargetable while it is.
{
    const nexuses = entitiesOfKind(a, KIND_BASE);
    const shielded = nexuses.filter(
        (e) => a.arena.world.has(e, Components.Shield)
            && a.arena.world.get(e, Components.Shield).active === 1,
    );
    check('both nexuses start shielded by their towers',
        !NEXUS_REQUIRES_TOWERS_DOWN || (nexuses.length === 2 && shielded.length === 2),
        `${shielded.length}/${nexuses.length} shielded`);
}

// --- Aim must decide the target, not proximity. Walk into the lane until at
// least two enemies are in range, aim at the FARTHEST, and check the hit came
// back at that one's position rather than the nearer one's.
{
    const sign = forwardZ(a.team!);
    let candidates: { entity: Entity; x: number; z: number; dist: number }[] = [];

    await waitForChampion(a);
    // Walk up the lane until the enemy wave is close enough to swing at.
    let closest = Infinity;
    for (let attempt = 0; attempt < 220 && candidates.length < 2 && a.entity !== null; attempt++) {
        a.client.sendIntent('move', { dx: 0, dz: sign });
        await sleep(1000 / TICK_RATE);
        candidates = enemiesInRange(a, ATTACK_RANGE);
        for (const c of enemiesInRange(a, 99)) closest = Math.min(closest, c.dist);
    }

    if (candidates.length < 2) {
        check('two enemies in range to tell aim apart', false,
            `only ${candidates.length} in range; nearest enemy got to ${closest.toFixed(2)}`);
    } else {
        candidates.sort((p, q) => p.dist - q.dist);
        const nearest = candidates[0];
        const farthest = candidates[candidates.length - 1];

        a.rpcLog.length = 0;
        a.client.sendIntent('attack', { aimX: farthest.x, aimZ: farthest.z });
        await sleep(500);

        const hit = a.rpcLog.find((r) => r.name === 'hitLanded')?.payload;
        const toAimed = hit === undefined ? Infinity : Math.hypot(hit.x - farthest.x, hit.z - farthest.z);
        const toNearest = hit === undefined ? 0 : Math.hypot(hit.x - nearest.x, hit.z - nearest.z);

        check('the swing lands on the aimed target, not the nearest one',
            hit !== undefined && toAimed < toNearest,
            hit === undefined
                ? 'no hitLanded came back'
                : `hit ${toAimed.toFixed(2)} from the aimed target, ${toNearest.toFixed(2)} from the nearest`);
        check('a landed hit reports its damage', hit !== undefined && hit.damage > 0, `${hit?.damage}`);
    }
}

// --- By now the first waves have marched out. Both ranks should be in them.
check('waves contain both minion ranks',
    countKind(a, KIND_MINION) > 0 && countKind(a, KIND_MINION_CASTER) > 0,
    `${countKind(a, KIND_MINION)} melee, ${countKind(a, KIND_MINION_CASTER)} caster`);

// --- Cleave: fires, echoes an fx broadcast, and respects its own cooldown.
//
// Walking up the lane above puts `a` inside an enemy wave: with a caster rank
// that out-ranges the melee one, dying there is a perfectly ordinary outcome
// and not something to assert about. Wait for the respawn rather than testing
// abilities on a corpse.
if (!(await waitForChampion(a))) {
    check('champion is alive to test abilities with', false, 'never respawned');
}
a.rpcLog.length = 0;
a.client.sendIntent('cleave', {});
await sleep(400);
const firstFx = a.rpcLog.filter((r) => r.name === 'cleaveFx');
check('cleave broadcasts a cleaveFx to every client', firstFx.length === 1,
    JSON.stringify(firstFx[0]?.payload));
check('cleaveFx reaches the OTHER client too', b.rpcLog.some((r) => r.name === 'cleaveFx'));

a.rpcLog.length = 0;
a.client.sendIntent('cleave', {});
await sleep(400);
check('a second cleave inside the cooldown is rejected',
    a.rpcLog.filter((r) => r.name === 'cleaveFx').length === 0);

// --- Potion, over the wire.
//
// A fresh champion is at full health, where drinking is *supposed* to do
// nothing, so this walks into the wave first to earn the interesting case. What
// the potion actually does to health is pinned down deterministically by
// `bun run rules`; what's checked here is the wire: that the intent reaches the
// server, and that the heal is broadcast to everyone rather than whispered to
// the drinker.
{
    await waitForChampion(a);
    await skirmish(a);

    // Read health *now*, not before the walk, which of the two rules applies is
    // decided by the state the server will actually see.
    const health = healthOf(a);
    a.rpcLog.length = 0;
    b.rpcLog.length = 0;
    a.client.sendIntent('potion', {});
    await sleep(500);
    const own = a.rpcLog.some((r) => r.name === 'healFx');
    const other = b.rpcLog.some((r) => r.name === 'healFx');

    // Health is read from an interpolated snapshot, so it lags the server by
    // the interpolation delay. A champion that looked hurt can already be dead
    // by the time the intent is resolved, and that is not the potion failing.
    if (healthOf(a) === null) {
        check('drinking is refused once the champion is dead', !own);
    } else if (health !== null && health.current < health.max) {
        check('drinking while hurt broadcasts the heal to every client', own && other,
            `at ${health.current}/${health.max}, own=${own}, other=${other}`);
    } else {
        // Untouched, or dead on the way back. Either way the server must refuse.
        check('drinking with nothing to heal is refused', !own,
            health === null ? 'champion was dead' : `at ${health.current}/${health.max}`);
    }
}

// --- Dash, over the wire.
//
// Forward rather than back: the champion has been walking toward its own base,
// and the lane boundary behind it would legitimately refuse the dash.
{
    await waitForChampion(a);
    const before = positionOf(a);
    a.rpcLog.length = 0;
    b.rpcLog.length = 0;
    a.client.sendIntent('dash', { dx: 0, dz: forwardZ(a.team!) });
    await sleep(500);

    const after = positionOf(a);
    const travelled = before === null || after === null
        ? 0
        : Math.hypot(after.x - before.x, after.z - before.z);

    check('a dash displaces the champion about DASH_DISTANCE',
        Math.abs(travelled - DASH_DISTANCE) < 1.5, `moved ${travelled.toFixed(2)}`);
    check('a dash is broadcast to every client',
        a.rpcLog.some((r) => r.name === 'dashFx') && b.rpcLog.some((r) => r.name === 'dashFx'));
}

// --- Bots fill BOTH teams up to the size asked for.
//
// The request names a size rather than asking for one more bot, so it is
// idempotent: sending it twice has to leave the arena exactly as it was, which
// is what makes a reconnect harmless.
{
    const before = new Set(entitiesOfKind(a, KIND_CHAMPION));
    a.client.sendRpc('fillTeams', { perTeam: PLAYERS_PER_TEAM });
    await sleep(1600);

    const perTeam = rosterSizes(a);
    check('asking for 3v3 fills both teams with bots',
        perTeam[0] === PLAYERS_PER_TEAM && perTeam[1] === PLAYERS_PER_TEAM,
        `team0=${perTeam[0]} vs team1=${perTeam[1]}`);

    // The two humans keep their seats; only the empty ones were filled.
    const appeared = entitiesOfKind(a, KIND_CHAMPION).filter((e) => !before.has(e));
    check('filling the teams leaves the seated players alone',
        appeared.length === PLAYERS_PER_TEAM * 2 - before.size,
        `${before.size} before, ${appeared.length} appeared`);

    a.client.sendRpc('fillTeams', { perTeam: PLAYERS_PER_TEAM });
    await sleep(1200);
    const again = rosterSizes(a);
    check('asking a second time changes nothing',
        again[0] === perTeam[0] && again[1] === perTeam[1],
        `team0=${again[0]} vs team1=${again[1]}`);

    // A bot that never leaves its spawn is a prop, not an opponent.
    const bot = appeared[0];
    const botStart = bot === undefined ? null : zOf(a, bot);
    await sleep(2500);
    const botNow = bot === undefined ? null : zOf(a, bot);
    check('the bots leave their spawn and walk the lane',
        botStart !== null && botNow !== null && Math.abs(botNow - botStart) > 0.5,
        `z ${botStart?.toFixed(2)} -> ${botNow?.toFixed(2)}`);
}

// --- A seat a human gives up is taken over by AI, and handed straight back.
b.close();
await sleep(1200);
{
    const perTeam = rosterSizes(a);
    check('a bot takes over the seat a human left',
        perTeam[0] === PLAYERS_PER_TEAM && perTeam[1] === PLAYERS_PER_TEAM,
        `team0=${perTeam[0]} vs team1=${perTeam[1]}`);
}

const c = await connect();
await sleep(1500);
check('a slot freed by a disconnect is reusable', c.entity !== null, `entity=${c.entity}`);
{
    const perTeam = rosterSizes(c);
    check('a human joining evicts a bot rather than growing the match',
        perTeam[0] === PLAYERS_PER_TEAM && perTeam[1] === PLAYERS_PER_TEAM,
        `team0=${perTeam[0]} vs team1=${perTeam[1]}`);
}

// --- The size can be lowered, but never below the people already playing.
{
    a.client.sendRpc('fillTeams', { perTeam: 1 });
    await sleep(1500);

    const perTeam = rosterSizes(a);
    const humans = 2; // `a` and `c`; `b` has gone
    const biggestSide = Math.max(perTeam[0], perTeam[1]);
    check('lowering the size drops the surplus bots',
        biggestSide < PLAYERS_PER_TEAM, `team0=${perTeam[0]} vs team1=${perTeam[1]}`);
    check('but never below the number of people seated',
        perTeam[0] + perTeam[1] >= humans && perTeam[0] === perTeam[1],
        `team0=${perTeam[0]} vs team1=${perTeam[1]}, ${humans} human(s)`);
}

// --- With every seat held by a person, the next arrival watches.
//
// A bot can never cause this: `joinHuman` evicts one rather than turn somebody
// away, so spectating means six humans and nothing else. `a` and `c` already
// hold two of the six.
const extras: Harness[] = [];
{
    while (extras.length < PLAYERS_PER_TEAM * 2 - 2) extras.push(await connect());
    await sleep(2500);

    const perTeam = rosterSizes(a);
    check('six people fill the arena between them',
        perTeam[0] === PLAYERS_PER_TEAM && perTeam[1] === PLAYERS_PER_TEAM,
        `team0=${perTeam[0]} vs team1=${perTeam[1]}`);
    check('and every one of them gets a champion',
        extras.every((h) => h.entity !== null),
        `${extras.filter((h) => h.entity !== null).length}/${extras.length} seated`);

    const watcher = await connect();
    await sleep(1500);
    const told = watcher.rpcLog.filter((r) => r.name === 'spectating');
    check('a seventh arrival is told it is spectating',
        told.length > 0 && told[told.length - 1].payload.active === 1,
        told.length === 0 ? 'never told' : JSON.stringify(told[told.length - 1].payload));
    check('and is given no champion', watcher.entity === null, `entity=${watcher.entity}`);

    // The wait ends on its own: nothing is asked for, the server just hands the
    // seat over when one opens.
    watcher.rpcLog.length = 0;
    extras.pop()?.close();
    await sleep(2000);
    check('and takes the seat as soon as somebody leaves',
        watcher.rpcLog.some((r) => r.name === 'spectating' && r.payload.active === 0)
            && watcher.entity !== null,
        `entity=${watcher.entity}`);
    watcher.close();
}
for (const extra of extras) extra.close();
await sleep(1200);

// --- Surrender ends the match through the normal victory path.
{
    a.rpcLog.length = 0;
    a.client.sendRpc('surrender', {});
    await sleep(700);
    const over = a.rpcLog.find((r) => r.name === 'matchOver')?.payload;
    check('surrendering ends the match for the other side',
        over !== undefined && over.winner === 1 - a.team!,
        over === undefined ? 'no matchOver' : `winner=team${over.winner}, surrendered as team${a.team}`);

    // And the arena comes back by itself, same as any other match end.
    await sleep((MATCH_RESET_SECONDS + 2) * 1000);
    check('the arena rebuilds after a surrender', a.rpcLog.some((r) => r.name === 'matchReset'));
}

a.close();
c.close();

console.log(`\n${results.join('\n')}`);
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
