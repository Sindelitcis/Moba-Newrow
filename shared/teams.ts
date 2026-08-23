import { LANE_HALF } from './constants';

/**
 * Team identity and team-relative geometry, in one place.
 *
 * The lane runs along Z: team A defends -Z, team B defends +Z. Almost every
 * "which way is forward / where is home / who is the enemy" decision in the
 * game is one of the helpers below, and they used to be written out inline as
 * `team === TEAM_A ? 1 : -1` and `1 - team` in a dozen places: server minion
 * marching, wave stagger, spawn points, client camera, client WASD. Having one
 * definition is what keeps the client's idea of "forward" from drifting out of
 * sync with the server's, which is exactly how W/S ended up inverted.
 */

/** Team ids. Team A defends -Z, team B defends +Z. */
export const TEAM_A = 0;
export const TEAM_B = 1;

/** Both teams, for the many loops that have to do a thing once per side. */
export const TEAMS = [TEAM_A, TEAM_B] as const;

export const PLAYERS_PER_TEAM = 3;

/** The other team. Two-sided game, so this is total. */
export function enemyOf(team: number): number {
    return team === TEAM_A ? TEAM_B : TEAM_A;
}

/** World-Z direction that points from `team`'s base toward the enemy's. */
export function forwardZ(team: number): 1 | -1 {
    return team === TEAM_A ? 1 : -1;
}

/** Z coordinate of `team`'s own base: the end of the lane it defends. */
export function baseZ(team: number): number {
    return -forwardZ(team) * LANE_HALF;
}
