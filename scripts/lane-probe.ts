/**
 * Headless lane measurement, for balance work.
 *
 * Runs the real systems with structures and waves but no champions, so the
 * numbers describe what minions do on their own: how many survive, how far they
 * push, and how fast a tower actually falls to them. Answering those from the
 * constants alone is guesswork, because the standing minion population is an
 * equilibrium between the spawn rate and a kill rate that itself depends on how
 * many minions are in range of each other.
 *
 *   bun run scripts/lane-probe.ts [seconds]
 *
 * It runs in real time, since the loop is timer-driven.
 */
import {
    Arena,
    Components,
    KIND_TOWER,
    TEAM_A,
    TEAM_B,
    forwardZ,
    MINION_STATS,
    isMinion,
} from '../shared';
import { createDealDamage } from '../server/damage';
import { createMatch } from '../server/match';
import { spawnStructures } from '../server/spawn';
import { registerGameSystems } from '../server/systems';

const SECONDS = Number(process.argv[2] ?? 90);

const arena = new Arena('server-timeout');
const { world } = arena;

const match = createMatch({ loop: arena.loop, onEnd: () => {}, onReset: () => {} });
const deal = createDealDamage(world, match, arena.loop.ticker, {
    onChampionKilled: () => {},
    onStructureDestroyed: (kind, team) => console.log(`    [${kind === KIND_TOWER ? 'tower' : 'nexus'} of team ${team} destroyed]`),
});
registerGameSystems(arena, match, deal, { onNexusExposed: () => {} });

spawnStructures(world);
arena.loop.start();

function minionsOf(team: number): number {
    let alive = 0;
    for (const e of world.query(Components.Team, Components.Kind)) {
        if (!isMinion(world.get(e, Components.Kind).value)) continue;
        if (world.get(e, Components.Team).id === team) alive++;
    }
    return alive;
}

/** How far `team`'s deepest minion has pushed, in team-relative depth. */
function frontline(team: number): number | null {
    let deepest: number | null = null;
    for (const e of world.query(Components.Team, Components.Kind, Components.Position)) {
        if (!isMinion(world.get(e, Components.Kind).value)) continue;
        if (world.get(e, Components.Team).id !== team) continue;
        const depth = world.get(e, Components.Position).z * forwardZ(team);
        if (deepest === null || depth > deepest) deepest = depth;
    }
    return deepest;
}

/**
 * How many of `team`'s minions have an enemy inside their own attack range,
 * and how far apart the two frontlines are.
 *
 * The standing population is an equilibrium between spawning and killing, and
 * the kill rate is capped by how many minions can actually reach something. If
 * that count is small while the population is large, the blob is milling around
 * out of range rather than fighting.
 */
function engagement(team: number): { engaged: number; spreadX: number } {
    const mine: { x: number; z: number; range: number }[] = [];
    const foes: { x: number; z: number }[] = [];

    for (const e of world.query(Components.Team, Components.Kind, Components.Position)) {
        const kind = world.get(e, Components.Kind).value;
        if (!isMinion(kind)) continue;
        const pos = world.get(e, Components.Position);
        const point = { x: pos.x, z: pos.z };
        if (world.get(e, Components.Team).id === team) {
            mine.push({ ...point, range: MINION_STATS[kind].attackRange });
        } else {
            foes.push(point);
        }
    }

    let engaged = 0;
    for (const m of mine) {
        if (foes.some((f) => Math.hypot(f.x - m.x, f.z - m.z) <= m.range)) engaged++;
    }
    const xs = mine.map((m) => m.x);
    const spreadX = xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
    return { engaged, spreadX };
}

/** Team B's frontmost surviving tower: the one team A's waves walk into first. */
function defendingTowerHealth(): number | null {
    let nearest: { z: number; hp: number } | null = null;
    for (const e of world.query(Components.Team, Components.Kind, Components.Position, Components.Health)) {
        if (world.get(e, Components.Kind).value !== KIND_TOWER) continue;
        if (world.get(e, Components.Team).id !== TEAM_B) continue;

        const z = world.get(e, Components.Position).z;
        const hp = world.get(e, Components.Health).current;
        // Team A advances along +Z, so the tower it meets first is the lowest z.
        if (nearest === null || z < nearest.z) nearest = { z, hp };
    }
    return nearest?.hp ?? null;
}

/**
 * Removes every minion of `team`, standing in for a champion clearing the wave.
 * The question a lane has to answer is what happens *after* someone wins a
 * fight, and that cannot be read off a symmetric stalemate.
 */
function clearMinionsOf(team: number): number {
    const doomed: number[] = [];
    for (const e of world.query(Components.Team, Components.Kind)) {
        if (!isMinion(world.get(e, Components.Kind).value)) continue;
        if (world.get(e, Components.Team).id === team) doomed.push(e);
    }
    for (const e of doomed) world.despawn(e);
    return doomed.length;
}

/** Second at which team B's wave is wiped, or 0 to leave the lane symmetric. */
const CLEAR_AT = Number(process.argv[3] ?? 0);

const pad = (value: string | number, width: number) => String(value).padStart(width);

console.log('  t  minA  minB  engA  spreadX  frontA  towerB');
for (let second = 1; second <= SECONDS; second++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (second === CLEAR_AT) console.log(`    [cleared ${clearMinionsOf(TEAM_B)} of team B's minions]`);
    const tower = defendingTowerHealth();
    const { engaged, spreadX } = engagement(TEAM_A);
    console.log(
        `${pad(second, 3)}  ${pad(minionsOf(TEAM_A), 4)}  ${pad(minionsOf(TEAM_B), 4)}  `
        + `${pad(engaged, 4)}  ${pad(spreadX.toFixed(1), 7)}  `
        + `${pad((frontline(TEAM_A) ?? Number.NaN).toFixed(1), 6)}  ${pad(tower ?? 'gone', 6)}`,
    );
}

arena.loop.stop();
process.exit(0);
