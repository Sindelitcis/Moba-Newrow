import type { Entity } from 'murow';
import type { GameServer, Peer } from 'murow/netcode';
import type { Arena, Intents, Rpcs } from '../shared';
import {
    Components,
    FEED_CHAMPION_KILL,
    FEED_FIRST_BLOOD,
    FEED_NEXUS_EXPOSED,
    FEED_TOWER_DESTROYED,
    KIND_TOWER,
    PLAYERS_PER_TEAM,
    RESPAWN_BASE_SECONDS,
    RESPAWN_MAX_SECONDS,
    RESPAWN_PER_DEATH_SECONDS,
    TEAMS,
    TEAM_A,
    TEAM_B,
    clamp,
    enemyOf,
} from '../shared';
import type { DamageListeners } from './damage';
import { createMatch, type Match } from './match';
import { Roster, type Player } from './roster';
import { Scoreboard } from './scoreboard';
import { spawnChampion, spawnStructures, resetChampion } from './spawn';
import type { SystemListeners } from './systems';

/** How often the match clock goes out to every client. */
const CLOCK_INTERVAL_SEC = 1;

type Server = GameServer<Intents, Rpcs>;

/**
 * Everything about *who is playing* and *what happens to them*: seats, spawn
 * slots, champions, respawns, bots, the score, the kill feed and the
 * match-over/reset cycle.
 *
 * Split out of `game-server.ts` so that file can be what it should be: a
 * composition root that builds the arena, the transport and the systems and
 * wires them together. The rules of the lobby are their own concern and are
 * far easier to reason about (and to read) with the plumbing out of the way.
 *
 * The host owns the `Match` rather than receiving one, because ending a match
 * and rebuilding the arena are the same decision seen from two sides: `Match`
 * knows *when*, the host knows *what to rebuild*.
 */
export interface MatchHost {
    readonly match: Match;
    /** Damage-side consequences (deaths, structures): hand to `createDealDamage`. */
    readonly damage: DamageListeners;
    /** Tick-system announcements: hand to `registerGameSystems`. */
    readonly systems: SystemListeners;
    /** Every bot currently seated, for the bot brain to advance. */
    bots(): readonly Player[];
    connect(peer: Peer): void;
    disconnect(peer: Peer, reason: string): void;
    /** Handles the two client → server RPCs; anything else is ignored. */
    rpc(peer: Peer, name: string, payload: unknown): void;
}

export interface MatchHostDeps {
    arena: Arena<'server-timeout'>;
    server: Server;
}

export function createMatchHost(deps: MatchHostDeps): MatchHost {
    const { arena, server } = deps;
    const { world, loop } = arena;

    const roster = new Roster();
    const scoreboard = new Scoreboard();
    /** Every connected peer, spectators included: the audience for score updates. */
    const peers = new Map<string, Peer>();
    /**
     * Champions per team the arena is being kept at with AI. Zero is pure PvP,
     * and is the default: bots only ever exist because somebody asked for them.
     *
     * One number for the whole arena rather than one per requester, because
     * there is one arena. The last request wins, which is what lets a size be
     * lowered as well as raised, and what makes the request idempotent: a
     * reconnect re-sending it is a no-op instead of another bot.
     */
    let botTarget = 0;

    const match = createMatch({
        loop,
        onEnd: (winner) => {
            server.broadcastRpc('matchOver', {
                winner,
                killsA: scoreboard.killsOf(TEAM_A),
                killsB: scoreboard.killsOf(TEAM_B),
            });
            console.log(`[server] match over: team ${winner} wins`);
        },
        onReset: () => rebuildArena(),
    });

    // --- Announcements -----------------------------------------------------

    function announce(event: number, team: number): void {
        server.broadcastRpc('feed', { event, team });
    }

    /**
     * Sends every peer the team totals plus their own tally. Per-peer rather
     * than broadcast because `selfKills`/`selfDeaths` differ per player, and
     * there's no notion of player identity on the wire to key them off
     * client-side.
     */
    function broadcastScores(): void {
        const killsA = scoreboard.killsOf(TEAM_A);
        const killsB = scoreboard.killsOf(TEAM_B);
        const sizeA = roster.countOn(TEAM_A);
        const sizeB = roster.countOn(TEAM_B);

        for (const [peerId, peer] of peers) {
            const self = scoreboard.scoreOf(peerId);
            server.sendRpc(peer, 'score', {
                killsA,
                killsB,
                selfKills: self.kills,
                selfDeaths: self.deaths,
                sizeA,
                sizeB,
            });
        }
    }

    loop.every(CLOCK_INTERVAL_SEC).seconds(() => {
        server.broadcastRpc('clock', { seconds: match.elapsedSeconds });
    });

    // --- Champion lifecycle ------------------------------------------------

    function spawnChampionFor(player: Player): void {
        const entity = spawnChampion(world, player.team, player.slot);
        roster.bindChampion(player, entity);
        // Bots have no socket to tell; everything else about them is identical.
        if (player.peer !== null) server.assignEntity(player.peer, entity);
    }

    function cancelRespawn(player: Player): void {
        if (player.respawnSchedule === null) return;
        loop.clearSchedule(player.respawnSchedule);
        player.respawnSchedule = null;
    }

    /**
     * Seconds this particular death costs: a flat base plus a penalty for
     * every death already taken, capped. Read *before* the death is recorded,
     * so the first one costs the base wait and nothing more.
     */
    function respawnDelayFor(playerId: string | null): number {
        const priorDeaths = playerId === null ? 0 : scoreboard.scoreOf(playerId).deaths;
        return Math.min(
            RESPAWN_MAX_SECONDS,
            RESPAWN_BASE_SECONDS + priorDeaths * RESPAWN_PER_DEATH_SECONDS,
        );
    }

    function onChampionKilled(victim: Entity, victimTeam: number, killer: Entity | null): void {
        const victimPlayer = roster.ownerOf(victim);
        const killerPlayer = roster.ownerOf(killer);
        const delay = respawnDelayFor(victimPlayer?.id ?? null);

        announce(scoreboard.firstBloodPending ? FEED_FIRST_BLOOD : FEED_CHAMPION_KILL, enemyOf(victimTeam));
        // A tower or minion landing the killing blow still scores for its team,
        // it just doesn't credit any individual player.
        scoreboard.recordChampionKill(victimTeam, victimPlayer?.id ?? null, killerPlayer?.id ?? null);
        broadcastScores();

        if (victimPlayer === undefined) return;
        roster.clearChampion(victimPlayer);
        if (match.over) return;

        if (victimPlayer.peer !== null) {
            server.sendRpc(victimPlayer.peer, 'respawnIn', { seconds: delay });
        }
        victimPlayer.respawnSchedule = loop.every(delay).seconds(() => {
            cancelRespawn(victimPlayer);
            if (match.over) return;
            spawnChampionFor(victimPlayer);
        });
    }

    /** Despawns a player's champion and takes them off the roster. */
    function removePlayer(player: Player): void {
        cancelRespawn(player);
        const champion = player.entity;
        roster.leave(player.id);
        scoreboard.remove(player.id);
        if (champion !== null && world.isAlive(champion)) world.despawn(champion);
    }

    /**
     * Brings both teams to the same size with bots, adding and removing as
     * needed. The single place the AI head-count is decided.
     *
     * The size is the largest of the requested target and either side's human
     * count, capped at `PLAYERS_PER_TEAM`. Taking the maximum rather than the
     * target alone is what keeps the sides even without a separate parity pass:
     * three humans on one side means the other side needs three champions
     * whatever was originally asked for, and a fourth human cannot appear
     * because the free-list has only three slots.
     *
     * Humans are never removed, so a side that is already fuller than the
     * target simply stays that way and the other side is filled to match.
     *
     * Runs whenever the roster or the target changes, and is written to be
     * idempotent: calling it twice does nothing the second time.
     */
    function rebalanceBots(): void {
        const target = botTarget === 0 ? 0 : Math.min(
            PLAYERS_PER_TEAM,
            Math.max(botTarget, ...TEAMS.map((team) => roster.countHumansOn(team))),
        );

        for (const team of TEAMS) {
            while (roster.countOn(team) > target) {
                const surplus = roster.bots().find((bot) => bot.team === team);
                // Only people left on this side: they stay, and the loop stops.
                if (surplus === undefined) break;
                removePlayer(surplus);
            }
            while (roster.countOn(team) < target) {
                const bot = roster.joinBot(team);
                if (bot === null) break;
                scoreboard.add(bot.id);
                // Mid-victory-screen: it takes the seat now and gets a champion
                // when the arena rebuilds, exactly as a human joining does.
                if (!match.over) spawnChampionFor(bot);
            }
        }
    }

    // --- Match reset -------------------------------------------------------

    /**
     * Tears the arena down and rebuilds it: every entity despawned, structures
     * respawned, and a fresh champion handed to each still-connected player.
     * Clients need no special handling beyond clearing the victory screen -
     * they learn the new world through the normal spawn/despawn stream.
     */
    function rebuildArena(): void {
        for (const player of roster.all()) cancelRespawn(player);

        // Snapshot before despawning: `query` hands back a cached buffer that
        // despawn mutates underneath the iteration. Every entity in this game
        // carries Position, so this walks the whole world.
        //
        // Living player champions are deliberately spared and recycled in place
        // (see `resetChampion`): despawning them here would hand their entity
        // ids straight back to the freshly spawned replacements and desync the
        // client's view of its own champion.
        for (const e of [...world.query(Components.Position)]) {
            if (!world.isAlive(e)) continue;
            if (roster.isChampion(e)) continue;
            world.despawn(e);
        }

        spawnStructures(world);
        scoreboard.reset();

        let revived = 0;
        for (const player of roster.all()) {
            if (player.entity !== null && world.isAlive(player.entity)) {
                resetChampion(world, player.entity, player.team, player.slot);
            } else {
                // Died during the match and never respawned (or joined mid-defeat).
                spawnChampionFor(player);
                revived++;
            }
        }

        server.broadcastRpc('matchReset', {});
        broadcastScores();
        console.log(`[server] arena reset: ${roster.size} player(s), ${revived} respawned from dead`);
    }

    // --- Connection handling -----------------------------------------------

    /**
     * Seats `peer` if the arena has room, and tells it either way.
     *
     * Shared by the two moments a person can take a seat: arriving, and having
     * waited for one to open. Both have to evict a bot, spawn a champion and
     * report the outcome, and doing that in two places is how the two drift.
     */
    function seatHuman(peer: Peer): boolean {
        // A human always outranks a bot for a seat. Evicting first, through the
        // full removal path, is what actually despawns the bot's champion.
        const evicted = roster.evictableBot();
        if (evicted !== null) {
            removePlayer(evicted);
            console.log(`[server] ${evicted.id} made way for peer ${peer.peerId}`);
        }

        const player = roster.joinHuman(peer);
        server.sendRpc(peer, 'spectating', { active: player === null ? 1 : 0 });
        if (player === null) return false;

        scoreboard.add(peer.peerId);
        // Joining mid-victory-screen: take the seat now, get a champion when the
        // arena rebuilds, rather than spawning into a match that already ended.
        if (!match.over) spawnChampionFor(player);
        console.log(`[server] peer ${peer.peerId} → team ${player.team}, slot ${player.slot}`);
        return true;
    }

    /**
     * Hands a seat to whoever has been waiting longest, now that one may have
     * opened.
     *
     * Only ever needed after somebody leaves. `joinHuman` evicts a bot rather
     * than turn a person away, so the only way to be spectating in the first
     * place is for all six seats to hold people, and the only way out of it is
     * for one of them to go. `peers` preserves insertion order, so this is
     * first-come first-served without a queue of its own.
     */
    function seatWaiting(): void {
        for (const [peerId, peer] of peers) {
            if (roster.get(peerId) !== undefined) continue;
            // Still nothing free: everyone behind this peer is waiting too.
            if (!seatHuman(peer)) return;
        }
    }

    function connect(peer: Peer): void {
        peers.set(peer.peerId, peer);

        if (!seatHuman(peer)) {
            console.log(`[server] peer ${peer.peerId} connected: every seat taken, spectating`);
            broadcastScores();
            return;
        }

        // A person arriving can make the match bigger than the size that was
        // asked for, and the other side has to grow to meet them.
        rebalanceBots();
        broadcastScores();
    }

    function disconnect(peer: Peer, reason: string): void {
        peers.delete(peer.peerId);

        const player = roster.get(peer.peerId);
        if (player === undefined) {
            scoreboard.remove(peer.peerId);
            console.log(`[server] spectator ${peer.peerId} left (${reason})`);
            return;
        }

        removePlayer(player);
        console.log(`[server] peer ${peer.peerId} left (${reason})`);

        // With nobody left to play against, the arena forgets the size the
        // departed player asked for, and `rebalanceBots` then clears the AI out
        // rather than leaving it shadow-boxing in an empty lane forever.
        if (roster.humans().length === 0) botTarget = 0;
        // A seat came free, so it goes to whoever was waiting *before* the bots
        // get a chance to top the teams back up.
        seatWaiting();
        rebalanceBots();
        broadcastScores();
    }

    function surrender(peer: Peer): void {
        const player = roster.get(peer.peerId);
        if (player === undefined || match.over) return;
        console.log(`[server] peer ${peer.peerId} surrendered for team ${player.team}`);
        match.end(player.team);
    }

    /**
     * Sets the size the arena is kept at with bots.
     *
     * Refused from a spectator: they have no seat, so letting them resize the
     * match would let somebody with no stake in it reshape a game already under
     * way. Clamped rather than validated, because a payload is a payload.
     */
    function fillTeams(peer: Peer, perTeam: number): void {
        if (roster.get(peer.peerId) === undefined) return;

        botTarget = clamp(Math.round(perTeam), 0, PLAYERS_PER_TEAM);
        rebalanceBots();
        broadcastScores();
        console.log(`[server] peer ${peer.peerId} set the arena to ${botTarget}v${botTarget}`);
    }

    return {
        match,

        damage: {
            onChampionKilled,
            onStructureDestroyed: (kind, team) => {
                if (kind === KIND_TOWER) announce(FEED_TOWER_DESTROYED, team);
            },
        },

        systems: {
            onNexusExposed: (team) => announce(FEED_NEXUS_EXPOSED, team),
        },

        bots: () => roster.bots(),
        connect,
        disconnect,

        rpc(peer, name, payload) {
            if (name === 'surrender') surrender(peer);
            else if (name === 'fillTeams') fillTeams(peer, (payload as { perTeam: number }).perTeam);
        },
    };
}
