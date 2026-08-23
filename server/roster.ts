import type { Entity } from 'murow';
import type { Peer } from 'murow/netcode';
import { PLAYERS_PER_TEAM, TEAMS, TEAM_A, TEAM_B } from '../shared';

/**
 * Per-player bookkeeping that survives champion death.
 *
 * `entity` is the authoritative record of which champion this player currently
 * owns: deliberately *not* read back off `peer.entity`. Murow only ever
 * writes `peer.entity` in `assignEntity` and never clears it on despawn, so
 * between a death and the respawn seconds later it still points at a destroyed
 * entity id. Since the ECS recycles ids, that stale id can by then belong to
 * something else entirely (a minion), and acting on it would despawn a live
 * unit and corrupt the team bookkeeping. `null` here means "dead, awaiting
 * respawn", which `peer.entity` has no way to express.
 *
 * A bot is a player with no `peer`. Everything downstream: spawning, respawn
 * scheduling, the match reset, the scoreboard, then treats it the same as a
 * human without a single special case, and the only places that check `peer`
 * are the ones that genuinely need a socket to talk to.
 */
export interface Player {
    readonly id: string;
    readonly peer: Peer | null;
    readonly team: number;
    readonly slot: number;
    entity: Entity | null;
    /** Id of the pending respawn schedule, or null when not waiting on one. */
    respawnSchedule: number | null;
}

/**
 * Who is playing, on which team, in which spawn slot, and which champion
 * entity is theirs right now.
 *
 * Spawn slots come from an explicit free-list rather than a running count:
 * deriving the slot from a count (`teamACount - 1`) handed the same slot to
 * two players whenever someone in the middle left, spawning them on top of
 * each other. Returning the exact slot on disconnect keeps them unique.
 */
export class Roster {
    private readonly players = new Map<string, Player>();
    /** Current champion entity -> owning player id, so a death can find its owner. */
    private readonly championOwners = new Map<Entity, string>();
    private readonly freeSlots: Record<number, number[]> = {
        [TEAM_A]: allSlots(),
        [TEAM_B]: allSlots(),
    };
    private nextBotNumber = 1;

    get size(): number {
        return this.players.size;
    }

    all(): Player[] {
        // A copy: callers iterate this while spawning, despawning and (for
        // bots) removing players, all of which mutate the map.
        return [...this.players.values()];
    }

    humans(): Player[] {
        return this.all().filter((p) => p.peer !== null);
    }

    bots(): Player[] {
        return this.all().filter((p) => p.peer === null);
    }

    get(id: string): Player | undefined {
        return this.players.get(id);
    }

    /** How many players (human or bot) are seated on `team`. */
    countOn(team: number): number {
        let seated = 0;
        for (const player of this.players.values()) {
            if (player.team === team) seated++;
        }
        return seated;
    }

    /**
     * How many of those are people.
     *
     * What decides how big the match has to be: a bot exists to give somebody an
     * opponent, so three humans on one side means the other side needs three
     * champions whatever size was originally asked for (see server/host.ts).
     */
    countHumansOn(team: number): number {
        let seated = 0;
        for (const player of this.players.values()) {
            if (player.team === team && player.peer !== null) seated++;
        }
        return seated;
    }

    /**
     * Seats `peer` on whichever side is emptier, or null when every slot is
     * taken. Call `evictableBot` first: a human waiting behind an AI opponent
     * is never the outcome anyone wants.
     */
    joinHuman(peer: Peer): Player | null {
        return this.seat(peer.peerId, peer, this.emptierTeam());
    }

    /**
     * A bot that should give up its seat so a person can have it, or null when
     * there is already room (or nothing to evict).
     *
     * Reported rather than removed, because removing a player is more than a
     * roster edit: the champion has to be despawned and the scoreboard entry
     * dropped, and only the host knows how to do either. Freeing the seat here
     * and handing back a `Player` whose `entity` had already been nulled by
     * `leave` is exactly how an evicted bot's champion ended up abandoned in
     * the world, still walking the lane with nobody owning it.
     */
    evictableBot(): Player | null {
        if (this.hasFreeSlot()) return null;
        return this.bots()[0] ?? null;
    }

    /** Seats a bot on `team`, or returns null if that side is full. */
    joinBot(team: number): Player | null {
        return this.seat(`bot-${this.nextBotNumber++}`, null, team);
    }

    /** Removes the player and frees their slot. Returns them, or undefined if unknown. */
    leave(id: string): Player | undefined {
        const player = this.players.get(id);
        if (player === undefined) return undefined;

        this.clearChampion(player);
        this.players.delete(id);

        const pool = this.freeSlots[player.team];
        if (pool !== undefined && !pool.includes(player.slot)) {
            pool.push(player.slot);
            pool.sort((a, b) => a - b);
        }
        return player;
    }

    /** The player who owns `entity`, if it's a champion that belongs to someone. */
    ownerOf(entity: Entity | null): Player | undefined {
        if (entity === null) return undefined;
        const id = this.championOwners.get(entity);
        return id === undefined ? undefined : this.players.get(id);
    }

    /** True while `entity` is somebody's live champion: used to spare it from a world wipe. */
    isChampion(entity: Entity): boolean {
        return this.championOwners.has(entity);
    }

    bindChampion(player: Player, entity: Entity): void {
        this.clearChampion(player);
        player.entity = entity;
        this.championOwners.set(entity, player.id);
    }

    clearChampion(player: Player): void {
        if (player.entity !== null) this.championOwners.delete(player.entity);
        player.entity = null;
    }

    private seat(id: string, peer: Peer | null, team: number): Player | null {
        const slot = this.freeSlots[team]?.shift();
        if (slot === undefined) return null;

        const player: Player = { id, peer, team, slot, entity: null, respawnSchedule: null };
        this.players.set(id, player);
        return player;
    }

    private hasFreeSlot(): boolean {
        return TEAMS.some((team) => this.freeSlots[team].length > 0);
    }

    /** Join whichever side is emptier, so 1v0 doesn't become 2v0. */
    private emptierTeam(): number {
        return this.freeSlots[TEAM_A].length >= this.freeSlots[TEAM_B].length ? TEAM_A : TEAM_B;
    }
}

function allSlots(): number[] {
    return Array.from({ length: PLAYERS_PER_TEAM }, (_, i) => i);
}
