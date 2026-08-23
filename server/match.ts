import type { GameLoop } from 'murow';
import { MATCH_RESET_SECONDS, TICK_RATE, enemyOf } from '../shared';

/**
 * The match's over/not-over state and its clock, as a single shared object.
 *
 * This exists because the over flag used to be duplicated: `game-server.ts`
 * had one `matchOver` and `server/systems.ts` had another, and only the minion
 * damage path ever set both. A base destroyed by a *champion* went through
 * `server/combat.ts`, which set the game-server's copy (so clients were told
 * the match ended) while leaving the systems' copy false, so minion waves
 * kept spawning, minions kept marching and towers kept firing underneath the
 * victory screen, forever. One owner, one flag.
 */
export interface Match {
    /** True from the moment a base falls until the next reset completes. */
    readonly over: boolean;
    /** Whole seconds since this match started, for the HUD clock. */
    readonly elapsedSeconds: number;
    /**
     * Declares `losingTeam`'s base destroyed. Idempotent: the first call wins
     * and any later call during the same match is ignored, so it's safe to
     * invoke from every damage path that can kill a base.
     */
    end(losingTeam: number): void;
}

export interface MatchDeps {
    loop: GameLoop<'server-timeout'>;
    /** The match just ended, `winner` took it. Fired exactly once per match. */
    onEnd(winner: number): void;
    /**
     * `MATCH_RESET_SECONDS` after that: rebuild the arena. The match is already
     * marked live again by the time this runs, so anything it spawns is part
     * of the new match rather than the finished one.
     */
    onReset(): void;
}

export function createMatch(deps: MatchDeps): Match {
    const { loop, onEnd, onReset } = deps;

    let over = false;
    let startedAtTick = loop.ticker.tickCount;
    let resetSchedule: number | null = null;

    return {
        get over() {
            return over;
        },

        get elapsedSeconds() {
            return Math.floor((loop.ticker.tickCount - startedAtTick) / TICK_RATE);
        },

        end(losingTeam) {
            if (over) return;
            over = true;
            onEnd(enemyOf(losingTeam));

            // The loop has no one-shot timer, so this is the same
            // clear-yourself-on-first-fire idiom the respawn schedule uses.
            resetSchedule = loop.every(MATCH_RESET_SECONDS).seconds(() => {
                if (resetSchedule !== null) loop.clearSchedule(resetSchedule);
                resetSchedule = null;

                over = false;
                startedAtTick = loop.ticker.tickCount;
                onReset();
            });
        },
    };
}
