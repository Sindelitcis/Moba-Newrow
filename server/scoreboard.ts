import { TEAM_A, TEAM_B, enemyOf } from '../shared';

/** One player's running tally. Reset along with the arena between matches. */
export interface PlayerScore {
    kills: number;
    deaths: number;
}

const NO_SCORE: Readonly<PlayerScore> = { kills: 0, deaths: 0 };

/**
 * Champion kills for the current match: per team (what both sides see) and per
 * player (what each individual player sees for themselves).
 *
 * Only champion deaths count: minions dying by the dozen would drown the
 * number out. A champion killed by a tower or a minion still scores for the
 * opposing *team*, it just doesn't credit any individual player, which is why
 * the two tallies are tracked separately rather than summed from one another.
 */
export class Scoreboard {
    private teamKills: Record<number, number> = { [TEAM_A]: 0, [TEAM_B]: 0 };
    private readonly players = new Map<string, PlayerScore>();

    /** Kills scored by `team`: i.e. enemy champions it has put down. */
    killsOf(team: number): number {
        return this.teamKills[team] ?? 0;
    }

    /** True until the first champion of the match dies. */
    get firstBloodPending(): boolean {
        return this.killsOf(TEAM_A) + this.killsOf(TEAM_B) === 0;
    }

    scoreOf(playerId: string): Readonly<PlayerScore> {
        return this.players.get(playerId) ?? NO_SCORE;
    }

    /**
     * Records a champion death. `victimId`/`killerId` are null when that side
     * of the kill isn't a player: a tower or minion landing the killing blow
     * still scores for its team.
     */
    recordChampionKill(victimTeam: number, victimId: string | null, killerId: string | null): void {
        this.teamKills[enemyOf(victimTeam)]++;
        if (victimId !== null) this.ensure(victimId).deaths++;
        if (killerId !== null) this.ensure(killerId).kills++;
    }

    add(playerId: string): void {
        this.ensure(playerId);
    }

    remove(playerId: string): void {
        this.players.delete(playerId);
    }

    /** Zeroes every tally, keeping the current players registered. */
    reset(): void {
        this.teamKills = { [TEAM_A]: 0, [TEAM_B]: 0 };
        for (const score of this.players.values()) {
            score.kills = 0;
            score.deaths = 0;
        }
    }

    private ensure(playerId: string): PlayerScore {
        let score = this.players.get(playerId);
        if (score === undefined) {
            score = { kills: 0, deaths: 0 };
            this.players.set(playerId, score);
        }
        return score;
    }
}
