import { f32, u8, u16 } from 'murow';
import { defineIntents, defineRpcs } from 'murow/netcode';

/**
 * Intents flow client → server.
 *
 * `move` is predictable (same math both sides, see predictions.ts). The two
 * abilities are handled server-only (see server/combat.ts): never predicted,
 * per Murow's own guidance for intents that resolve hits: the client plays its
 * swing optimistically and the server decides what it actually touched.
 */
const intentSchemas = {
    move: { dx: f32, dz: f32 },
    /**
     * `aimX`/`aimZ` is the world point the attacker is pointing at. The server
     * hits the closest legal target to it (server/abilities.ts), so aim can only
     * rank candidates that were already hittable.
     *
     * A point rather than an entity id: entity ids are not a shared namespace.
     * `GameClient` keeps its own local ids and its server-to-local map is
     * private, so a client cannot name a server entity. Positions are
     * networked, which makes them the one vocabulary both sides share.
     */
    attack: { aimX: f32, aimZ: f32 },
    cleave: {},
    /** Drink. No payload: it targets the caster, and the amounts are server constants. */
    potion: {},
    /**
     * Displace along `[dx, dz]`.
     *
     * Direction only. The server normalises the vector and owns the distance,
     * so a longer vector buys no extra range. Accepting the direction itself is
     * safe: a player can already walk in any direction, so naming one grants
     * nothing new.
     */
    dash: { dx: f32, dz: f32 },
};

export const intents = defineIntents(intentSchemas);

/**
 * Kill-feed event codes, carried by the `feed` RPC.
 *
 * A small enum on the wire rather than a string: the payload schemas are fixed
 * numeric fields, and the wording is a presentation decision that belongs on
 * the client anyway (the HUD is in Portuguese; the protocol shouldn't be).
 */
export const FEED_CHAMPION_KILL = 0;
export const FEED_FIRST_BLOOD = 1;
export const FEED_TOWER_DESTROYED = 2;
export const FEED_NEXUS_EXPOSED = 3;

/**
 * RPCs. Bidirectional in Murow; which direction each one actually travels is
 * noted below.
 */
const rpcSchemas = {
    /**
     * Server → everyone. `matchReset` carries no payload: the world is rebuilt
     * from scratch and the client learns the new entities through the normal
     * spawn/despawn stream, so all it needs to say is "clear the victory
     * screen".
     */
    matchOver: { winner: u8, killsA: u16, killsB: u16 },
    matchReset: {},
    /**
     * Server → everyone, once a second. A match clock is the one HUD element
     * that can't be derived client-side: a player who joins mid-match has no
     * idea when it started, and counting locally from the first snapshot would
     * show them a different time from everyone else's.
     */
    clock: { seconds: u16 },
    /**
     * Server → one peer. Team totals, this player's own tally, and how many
     * champions each side fields.
     *
     * The one RPC sent per-peer rather than broadcast: the team totals are the
     * same for everyone, but `selfKills`/`selfDeaths` are that particular
     * player's, and there is no other notion of player identity on the wire to
     * key them off client-side. The head-count is here because "why am I
     * facing two of them?" is otherwise unanswerable from inside the game -
     * bots fill empty slots, and a forgotten second tab is a team-mate you
     * can't see.
     */
    score: { killsA: u16, killsB: u16, selfKills: u16, selfDeaths: u16, sizeA: u8, sizeB: u8 },
    /**
     * Server → the dead peer. How long *this* death costs, which the client
     * cannot work out for itself now that the wait scales with how many times
     * you have already died (see `RESPAWN_PER_DEATH_SECONDS`).
     */
    respawnIn: { seconds: f32 },
    /**
     * Server → one peer: whether that peer has a seat at all.
     *
     * Sent because the client cannot infer it. A seated player learns it is
     * seated from `assignEntity`, but a player who could not be seated receives
     * nothing whatsoever, and "no champion yet" is indistinguishable from a slow
     * connection or a match between rounds. Sent again with `active` cleared
     * when a seat opens up, so the wait ends without the player doing anything.
     */
    spectating: { active: u8 },
    /**
     * Server → everyone. A notable thing happened: see the `FEED_*` codes.
     * `team` is whoever the event is *about*: the team that scored the kill,
     * or the team that just lost a structure.
     */
    feed: { event: u8, team: u8 },
    /**
     * Server → everyone. The only ability effect that has to reach everyone: a
     * basic attack shows up as the victim's HP dropping (which the client
     * already reacts to), but a cleave that hits nothing at all would
     * otherwise be completely invisible to every player but the caster.
     */
    cleaveFx: { x: f32, z: f32, team: u8 },
    /**
     * Server → everyone: somebody just drank.
     *
     * Broadcast rather than sent to the caster alone, because "they potioned"
     * is information the *other* side needs most: it is the difference between
     * committing to a kill and backing off. The heal itself shows up as their
     * health bar climbing; this is the cue that tells you why.
     */
    healFx: { x: f32, z: f32, team: u8 },
    /**
     * Server to everyone: a champion dashed, along this path.
     *
     * Carries both ends so every client draws the same trail. Without it the
     * displacement still arrives, as an interpolated jump in the next snapshot,
     * but with nothing to identify it as an ability rather than a hitch.
     */
    dashFx: { fromX: f32, fromZ: f32, toX: f32, toZ: f32, team: u8 },
    /**
     * Server → the attacking peer only: your swing connected, here and for
     * this much.
     *
     * Sent rather than inferred, because the two are different facts. The
     * client can see any entity's health drop, but it cannot see *who* caused
     * it, and reacting to every drop meant a minion trading blows with
     * another minion lit up the screen exactly as loudly as your own swing.
     * Carries a position instead of an entity id because the client's
     * server→local id mapping is internal to `GameClient`.
     */
    hitLanded: { x: f32, z: f32, damage: u16, lethal: u8 },
    /**
     * Client → server, sent once on connect when the player picked a size
     * against bots: keep both teams topped up to `perTeam` champions with AI.
     *
     * A target rather than "give me one more bot", which is what this replaced.
     * Being idempotent is the whole point: a reconnect re-sends it and nothing
     * changes, where the incremental version had to remember which bot belonged
     * to which requester purely so a flaky connection could not quietly fill the
     * arena with AI. It is also the only shape that can lower a size as well as
     * raise one.
     *
     * Still a request rather than a match mode, because the arena is shared: one
     * server, one lane, whoever is connected. Bots fill the seats nobody wants
     * and give them straight back, so a human arriving is never turned away by
     * one (see server/roster.ts). Zero means pure PvP and is simply never sent.
     */
    fillTeams: { perTeam: u8 },
    /**
     * Client → server: concede the match on behalf of the sender's team.
     *
     * Runs through the ordinary match-over path rather than a special reset,
     * so the victory screen, the final score and the countdown to the rebuilt
     * arena all behave exactly as they do when a nexus actually falls.
     */
    surrender: {},
};

export const rpcs = defineRpcs(rpcSchemas);

/**
 * The two schema maps, as types.
 *
 * `GameServer`/`GameClient` are generic over the *schemas*, not over the
 * `Defined*` wrappers, and nothing recovers one from the other, so anything
 * that wants to name a fully-typed server or client (server/host.ts, the smoke
 * test's harness) needs these. Declaring the schema objects as plain consts
 * first and inferring from them is what makes that a one-liner instead of a
 * conditional-type puzzle, and it keeps a mistyped payload a compile error at
 * every `sendRpc` call site rather than a silently mis-encoded packet.
 */
export type Intents = typeof intentSchemas;
export type Rpcs = typeof rpcSchemas;
