/**
 * Deterministic check of the game's rules, with no network in the way.
 *
 * `smoke-client.ts` plays the game over a real socket, which is the right way
 * to test the things that only exist once there are peers: seats, bots, the
 * score, the match cycle. It is the wrong way to test a rule that needs three
 * specific units standing in three specific places: choreographing that with
 * movement intents is slow, flaky, and mostly measures the bot.
 *
 * So this builds an `Arena` directly, registers the real systems against it,
 * and puts entities exactly where a rule needs them. No server, no client, no
 * sockets: just the world and `server/`.
 *
 * The last two sections are the exception, and belong here for the same reason
 * the rest does. Click-to-move is decided entirely on the client (see
 * src/game/navigation.ts for why), but none of that decision needs a canvas, a
 * renderer or a socket: it is arithmetic over a board, which is exactly what
 * this script is for.
 *
 *   bun run rules
 */
import type { Entity } from 'murow';
import {
    ATTACK_DAMAGE,
    Arena,
    CHAMPION_HP,
    CHAMPION_RADIUS,
    Components,
    DASH_DISTANCE,
    KIND_BASE,
    KIND_CHAMPION,
    KIND_MINION,
    KIND_TOWER,
    LANE_MAX_Z,
    LANE_WIDTH_HALF,
    MOVE_SPEED,
    NEXUS_REQUIRES_TOWERS_DOWN,
    TEAM_A,
    TEAM_B,
    TICK_RATE,
    TOWER_CHAMPION_AGGRO_SEC,
    TOWER_INNER_Z,
    TOWER_RADIUS,
    baseZ,
    isStructure,
    stepChampion,
} from '../shared';
import {
    isReady,
    positionOf,
    resolveDash,
    resolvePotion,
    type DashPath,
} from '../server/abilities';
import { createBotBrain } from '../server/bot';
import { createDealDamage } from '../server/damage';
import { createMatch } from '../server/match';
import type { Player } from '../server/roster';
import { spawnStructures } from '../server/spawn';
import { registerGameSystems } from '../server/systems';
import { findNearestEnemyInRange } from '../server/targeting';
import { createNavigator, type NavUnit } from '../src/game/navigation';
import { screenToGround, worldToScreen } from '../src/game/projection';

const results: string[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures++;
}

/** Waits `seconds` of real time, plus a little slack for the timer driver. */
const waitSeconds = (seconds: number) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 60));

const arena = new Arena('server-timeout');
const { world } = arena;

/** Everything the systems announce, so the tests can assert on it. */
const exposed: number[] = [];
const championDeaths: number[] = [];

const match = createMatch({ loop: arena.loop, onEnd: () => {}, onReset: () => {} });
const deal = createDealDamage(world, match, arena.loop.ticker, {
    onChampionKilled: (_victim, team) => championDeaths.push(team),
    onStructureDestroyed: () => {},
});
registerGameSystems(arena, match, deal, {
    onNexusExposed: (team) => exposed.push(team),
});

/** Spawns a unit exactly where a rule needs it, bypassing the usual spawn points. */
function place(team: number, kind: number, hp: number, x: number, z: number): Entity {
    const e = world.spawn();
    world.add(e, Components.Position, { x, z });
    world.add(e, Components.Team, { id: team });
    world.add(e, Components.Kind, { value: kind });
    world.add(e, Components.Health, { current: hp, max: hp });
    if (kind !== KIND_BASE) world.add(e, Components.Timers, { ...Components.ZERO_TIMERS });
    if (kind === KIND_TOWER || kind === KIND_BASE) {
        const shielded = kind === KIND_BASE && NEXUS_REQUIRES_TOWERS_DOWN;
        world.add(e, Components.Shield, { active: shielded ? 1 : 0 });
    }
    return e;
}

function remove(...entities: Entity[]): void {
    for (const e of entities) {
        if (world.isAlive(e)) world.despawn(e);
    }
}

function healthOf(entity: Entity): number {
    return world.isAlive(entity) && world.has(entity, Components.Health)
        ? world.get(entity, Components.Health).current
        : 0;
}

function isShielded(entity: Entity): boolean {
    return world.has(entity, Components.Shield) && world.get(entity, Components.Shield).active === 1;
}

type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function unit(v: Vec3): Vec3 {
    const length = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * View-projection matrix of a camera at `eye` looking at `target`.
 *
 * Test scaffolding rather than a second copy of anything the game ships: the
 * renderer's `Camera3D` needs a GPU device to construct, and the round trip it
 * is used for below only needs *a* matrix in the convention `worldToScreen`
 * reads, which is column-major, column vectors, right-handed, and `w` equal to
 * the distance along the view axis.
 */
function viewProjection(
    eye: Vec3,
    target: Vec3,
    fovDegrees: number,
    aspect: number,
    near: number,
    far: number,
): Float32Array {
    const forward = unit([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const right = unit(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);

    const view = new Float32Array([
        right[0], up[0], -forward[0], 0,
        right[1], up[1], -forward[1], 0,
        right[2], up[2], -forward[2], 0,
        -dot(right, eye), -dot(up, eye), dot(forward, eye), 1,
    ]);

    const focal = 1 / Math.tan((fovDegrees * Math.PI) / 360);
    const projection = new Float32Array(16);
    projection[0] = focal / aspect;
    projection[5] = focal;
    projection[10] = far / (near - far);
    projection[11] = -1;
    projection[14] = (far * near) / (near - far);

    const out = new Float32Array(16);
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += projection[k * 4 + row] * view[column * 4 + k];
            out[column * 4 + row] = sum;
        }
    }
    return out;
}

arena.loop.start();

// --- The nexus is only reachable once its towers are gone ------------------
{
    const nexus = place(TEAM_B, KIND_BASE, 800, 0, baseZ(TEAM_B));
    const tower = place(TEAM_B, KIND_TOWER, 450, 0, baseZ(TEAM_B) - 4);
    // Within a champion's reach of the nexus, and far enough from the tower to
    // survive the couple of shots this takes.
    const attacker = place(TEAM_A, KIND_CHAMPION, 140, 1.5, baseZ(TEAM_B) - 1.5);

    await waitSeconds(0.2);
    check('a nexus with a tower still standing is shielded', isShielded(nexus));

    const fullHealth = healthOf(nexus);
    deal(nexus, ATTACK_DAMAGE, attacker);
    check('a shielded nexus takes no damage', healthOf(nexus) === fullHealth,
        `${fullHealth} -> ${healthOf(nexus)}`);
    check('a shielded nexus is not a legal target',
        findNearestEnemyInRange(world, attacker, 10, [KIND_BASE]) === null);

    remove(tower);
    await waitSeconds(0.2);

    check('the nexus opens up once the last tower falls', !isShielded(nexus));
    check('opening a nexus is announced exactly once',
        exposed.filter((team) => team === TEAM_B).length === 1,
        `announced ${exposed.filter((team) => team === TEAM_B).length}x`);
    check('an exposed nexus is targetable',
        findNearestEnemyInRange(world, attacker, 10, [KIND_BASE]) === nexus);

    deal(nexus, ATTACK_DAMAGE, attacker);
    check('an exposed nexus takes damage', healthOf(nexus) === fullHealth - ATTACK_DAMAGE,
        `${fullHealth} -> ${healthOf(nexus)}`);

    remove(nexus, attacker);
    await waitSeconds(0.1);
}

// --- Towers defend: a diver outranks the minion the tower was shooting -----
{
    // Mid-lane, well clear of either end, so only these four are in play. The
    // bait minion is parked inside its own attack range of `victim`, which is
    // what keeps it engaged and standing still instead of marching off.
    const tower = place(TEAM_A, KIND_TOWER, 450, 0, 0);
    const bait = place(TEAM_B, KIND_MINION, 5000, 2.0, 1.0);
    const victim = place(TEAM_A, KIND_CHAMPION, 5000, 2.0, 2.5);
    const diver = place(TEAM_B, KIND_CHAMPION, 5000, -2.0, 1.0);

    // Left alone, the tower shoots minions: standard aggro priority.
    const baitStart = healthOf(bait);
    const diverStart = healthOf(diver);
    await waitSeconds(2);
    check('a tower shoots minions while nobody is diving',
        healthOf(bait) < baitStart && healthOf(diver) === diverStart,
        `minion ${baitStart} -> ${healthOf(bait)}, champion ${diverStart} -> ${healthOf(diver)}`);

    // The diver opens on a champion inside the tower's range: the tower should
    // drop the minion and answer.
    const diverBeforeDive = healthOf(diver);
    deal(victim, ATTACK_DAMAGE, diver);
    await waitSeconds(2);
    check('a tower switches to a champion that attacks one of ours in its range',
        healthOf(diver) < diverBeforeDive,
        `champion ${diverBeforeDive} -> ${healthOf(diver)}`);

    // …and lets go again once the aggro window lapses. Sampled only *after*
    // waiting the window out: measuring from the moment of the dive would
    // straddle the boundary and count the last legitimate shot as a failure.
    await waitSeconds(TOWER_CHAMPION_AGGRO_SEC);
    const diverSettled = healthOf(diver);
    const baitSettled = healthOf(bait);
    await waitSeconds(2);
    check('tower aggro lapses and it goes back to the wave',
        healthOf(diver) === diverSettled && healthOf(bait) < baitSettled,
        `champion ${diverSettled} -> ${healthOf(diver)}, minion ${baitSettled} -> ${healthOf(bait)}`);

    remove(tower, bait, victim, diver);
}

// --- A never-used ability is ready, even seconds into a fresh process ------
//
// `Timers` stores zero for "never used". Reading that as a timestamp makes the
// elapsed check `tick - 0`, so nothing is off cooldown until the server has run
// for a full cooldown: on a fresh process that locked out the potion for thirty
// seconds and the dash for twelve.
{
    const fresh = place(TEAM_A, KIND_CHAMPION, CHAMPION_HP, 0, 0);
    const earlyTick = 5; // well inside every cooldown in the game

    for (const field of ['attackTick', 'cleaveTick', 'potionTick', 'dashTick'] as const) {
        check(`${field} is ready when it has never been used`,
            isReady(world, fresh, earlyTick, field));
    }

    remove(fresh);
    await waitSeconds(0.1);
}

// --- The potion heals through damage, which nothing else does --------------
{
    const drinker = place(TEAM_A, KIND_CHAMPION, CHAMPION_HP, 0, 0);
    const enemy = place(TEAM_B, KIND_CHAMPION, CHAMPION_HP, 1, 0);

    check('a potion is refused at full health',
        !resolvePotion(world, drinker, arena.loop.ticker.tickCount),
        `${healthOf(drinker)}/${CHAMPION_HP}`);

    // Hurt it. `deal` stamps the out-of-combat timer, so ordinary regen is now
    // switched off for the next `CHAMPION_REGEN_DELAY_SEC`.
    deal(drinker, 100, enemy);
    const hurt = healthOf(drinker);
    await waitSeconds(1.5);
    check('ordinary regen stays off right after taking a hit',
        healthOf(drinker) === hurt, `${hurt} -> ${healthOf(drinker)}`);

    check('a potion is accepted while hurt',
        resolvePotion(world, drinker, arena.loop.ticker.tickCount));
    await waitSeconds(1.5);
    const healed = healthOf(drinker);
    check('a potion heals while still out of combat regen', healed > hurt,
        `${hurt} -> ${healed}`);

    // The whole point: take another hit and keep healing anyway.
    deal(drinker, 5, enemy);
    const afterHit = healthOf(drinker);
    await waitSeconds(1.5);
    check('a potion keeps healing through damage', healthOf(drinker) > afterHit,
        `${afterHit} -> ${healthOf(drinker)}`);

    check('a second potion inside the cooldown is refused',
        !isReady(world, drinker, arena.loop.ticker.tickCount, 'potionTick'));

    remove(drinker, enemy);
    await waitSeconds(0.1);
}

// --- The dash moves a fixed distance, and stops at the lane boundary -------
{
    const runner = place(TEAM_A, KIND_CHAMPION, CHAMPION_HP, 0, 0);
    const tick = () => arena.loop.ticker.tickCount;

    const path = resolveDash(world, runner, tick(), 0, 1);
    check('a dash returns the path it travelled', path !== null);
    if (path !== null) {
        const travelled = Math.hypot(path.toX - path.fromX, path.toZ - path.fromZ);
        check('a dash covers exactly DASH_DISTANCE',
            Math.abs(travelled - DASH_DISTANCE) < 0.01, `${travelled.toFixed(2)}`);
    }
    check('a second dash inside the cooldown is refused',
        !isReady(world, runner, tick(), 'dashTick'));

    // Distance is the server's, not the client's: a direction ten times as long
    // must not travel ten times as far.
    world.update(runner, Components.Timers, { ...Components.ZERO_TIMERS });
    const before = positionOf(world, runner);
    const long = resolveDash(world, runner, tick(), 0, 10);
    check('an over-long direction vector buys no extra distance',
        before !== null && long !== null
            && Math.abs(Math.hypot(long.toX - before.x, long.toZ - before.z) - DASH_DISTANCE) < 0.01);

    // Facing the wall: refused rather than spending twelve seconds on nothing.
    world.update(runner, Components.Timers, { ...Components.ZERO_TIMERS });
    world.update(runner, Components.Position, { x: LANE_WIDTH_HALF, z: 0 });
    check('a dash into the lane boundary is refused',
        resolveDash(world, runner, tick(), 1, 0) === null);
    check('a refused dash does not spend the cooldown',
        isReady(world, runner, tick(), 'dashTick'));

    remove(runner);
    await waitSeconds(0.1);
}

// --- The bot spends the dash, through the same resolver players use --------
//
// Checked here rather than by watching a bot on screen: `Position` is synced
// with `interp: 'lerp'`, so a remote dash is smoothed across the interpolation
// window and never appears as a discrete jump on any client.
{
    const dashes: DashPath[] = [];
    const brain = createBotBrain(world, match, deal, {
        onCleave: () => {},
        onHeal: () => {},
        onDash: (path) => dashes.push(path),
    });

    const bot: Player = {
        id: 'bot-test', peer: null, team: TEAM_B, slot: 0,
        entity: place(TEAM_B, KIND_CHAMPION, CHAMPION_HP, 0, 0),
        respawnSchedule: null,
    };
    // Just outside a swing, well inside a dash plus a swing.
    const prey = place(TEAM_A, KIND_CHAMPION, CHAMPION_HP, 0, -5);

    brain.update([bot], arena.loop.ticker.tickCount, 1 / 20);

    check('a healthy bot dashes at a champion just out of reach', dashes.length === 1,
        `${dashes.length} dash(es)`);
    if (dashes.length === 1) {
        const [path] = dashes;
        const travelled = Math.hypot(path.toX - path.fromX, path.toZ - path.fromZ);
        check('the bot dash covers the same distance a player gets',
            Math.abs(travelled - DASH_DISTANCE) < 0.01, `${travelled.toFixed(2)}`);
        check('the bot dashes toward its target, not away',
            path.toZ < path.fromZ, `z ${path.fromZ.toFixed(2)} -> ${path.toZ.toFixed(2)}`);
    }

    if (bot.entity !== null) remove(bot.entity);
    remove(prey);
    await waitSeconds(0.1);
}

// --- A champion death is reported once, for the right team -----------------
{
    const doomed = place(TEAM_A, KIND_CHAMPION, ATTACK_DAMAGE, 0, 0);
    const killer = place(TEAM_B, KIND_CHAMPION, 140, 1, 0);

    deal(doomed, ATTACK_DAMAGE, killer);
    check('a champion death is reported once, for the victim\'s team',
        championDeaths.length === 1 && championDeaths[0] === TEAM_A,
        `[${championDeaths.join(', ')}]`);

    remove(killer);
}

// --- Screen to ground: the unprojection click-to-move stands on ------------
//
// Everything else in the client goes world to screen; a click needs the way
// back. Checked as a round trip through `worldToScreen`, which is the property
// that actually matters and the one that breaks if the matrix inverse, the
// perspective divide or the viewport mapping is wrong.
{
    const WIDTH = 1280;
    const HEIGHT = 720;
    // The chase camera scene.ts sets up, over a champion standing on the centre
    // line.
    const chase = viewProjection([0, 20, -13], [0, 0, 0], 55, WIDTH / HEIGHT, 0.05, 250);
    const samples = [{ x: 0, z: 0 }, { x: 3.5, z: -6 }, { x: -4.5, z: 9 }, { x: 1, z: 14 }];

    let projected = 0;
    let worst = 0;
    for (const point of samples) {
        const screen = worldToScreen(chase, point.x, 0, point.z, WIDTH, HEIGHT);
        if (screen === null) continue;
        projected++;
        const back = screenToGround(chase, screen.x, screen.y, WIDTH, HEIGHT);
        worst = back === null
            ? Infinity
            : Math.max(worst, Math.hypot(back.x - point.x, back.z - point.z));
    }
    check('screenToGround inverts worldToScreen on the ground plane',
        projected === samples.length && worst < 0.01,
        `${projected}/${samples.length} projected, worst error ${worst.toFixed(5)}`);

    // A pixel whose ray never comes back down. Clicking the sky has to be
    // refused rather than resolved to whatever the arithmetic happens to
    // produce, which for a ray pointing away from the plane is a point behind
    // the camera.
    const level = viewProjection([0, 5, -10], [0, 5, 0], 55, WIDTH / HEIGHT, 0.05, 250);
    check('a click above the horizon has no ground point',
        screenToGround(level, WIDTH / 2, 0, WIDTH, HEIGHT) === null);
}

// --- Click-to-move: the destination, the path, and the WASD override -------
//
// The destination lives on the client and never reaches the wire (see
// src/game/navigation.ts for why), so there is no server rule to check here.
// What there is instead is a decision taken twenty times a second about which
// of the two input schemes the champion is obeying, and a path that has to bend
// around the same towers everything else does. Neither needs a canvas.
{
    spawnStructures(world);

    const board: NavUnit[] = [];
    for (const e of world.query(Components.Position, Components.Kind)) {
        const kind = world.get(e, Components.Kind).value;
        if (!isStructure(kind)) continue;
        // Copy out before the next `world.get`: it hands back one object per
        // component type, reused across calls.
        const pos = world.get(e, Components.Position);
        board.push({ entity: e, kind, x: pos.x, z: pos.z });
    }

    const nav = createNavigator();
    nav.syncBlockers(board);

    const STEP = 1 / TICK_RATE;
    /** Nobody touching the keyboard: the case a standing order actually runs in. */
    const idle = { active: false, direction: null };

    /** Walks the standing order to wherever it ends, exactly as the client would. */
    function walkOrder(startX: number, startZ: number) {
        let x = startX;
        let z = startZ;
        const trail = [{ x, z }];
        for (let tick = 0; tick < 400; tick++) {
            const heading = nav.steer(x, z, STEP, idle);
            if (heading === null) break;
            const next = stepChampion(x, z, heading.dx, heading.dz, STEP);
            x = next.x;
            z = next.z;
            trail.push({ x, z });
        }
        return { x, z, trail, arrived: nav.destination === null };
    }

    // Nothing between (0, 0) and (3, 3), so the order should be taken as given
    // and walked in a straight line.
    {
        const open = nav.order(0, 0, 3, 3);
        check('an order across open ground is taken as given',
            Math.abs(open.x - 3) < 1e-6 && Math.abs(open.z - 3) < 1e-6,
            `(${open.x}, ${open.z})`);

        const heading = nav.steer(0, 0, STEP, idle);
        check('and it steers straight at it',
            heading !== null
                && Math.abs(heading.dx - Math.SQRT1_2) < 0.01
                && Math.abs(heading.dz - Math.SQRT1_2) < 0.01,
            heading === null ? 'stood still' : `(${heading.dx.toFixed(3)}, ${heading.dz.toFixed(3)})`);

        const walked = walkOrder(0, 0);
        check('reaching the destination stops the champion and clears the order',
            walked.arrived && Math.hypot(walked.x - 3, walked.z - 3) <= MOVE_SPEED * STEP,
            `stopped at (${walked.x.toFixed(2)}, ${walked.z.toFixed(2)}), destination=${nav.destination}`);
    }

    // (0, 4) to (0, 10) runs straight through team B's inner tower, which is
    // the whole reason the navmesh is here rather than a normalised difference.
    {
        nav.order(0, 4, 0, 10);
        const heading = nav.steer(0, 4, STEP, idle);
        check('a path through a tower leaves the straight line',
            heading !== null && Math.abs(heading.dx) > 0.05,
            heading === null ? 'stood still' : `dx=${heading.dx.toFixed(3)}`);

        nav.order(0, 4, 0, 10);
        const detour = walkOrder(0, 4);
        let closest = Infinity;
        for (const step of detour.trail) {
            closest = Math.min(closest, Math.hypot(step.x, step.z - TOWER_INNER_Z));
        }
        check('the detour still arrives on the far side of the tower',
            detour.arrived && Math.hypot(detour.x, detour.z - 10) <= MOVE_SPEED * STEP,
            `stopped at (${detour.x.toFixed(2)}, ${detour.z.toFixed(2)})`);
        check('and never walks through the tower it went around',
            closest > TOWER_RADIUS,
            `closest approach ${closest.toFixed(2)}, tower radius ${TOWER_RADIUS}`);
    }

    // The rule the two schemes coexist by. Without it the destination survives
    // underneath a player who has taken over by hand, and comes back the moment
    // they let go of the keys.
    {
        nav.order(0, 0, 0, 8);
        const took = nav.steer(0, 0, STEP, { active: true, direction: { dx: 1, dz: 0 } });
        check('a movement key cancels the destination on the spot', nav.destination === null,
            `destination=${JSON.stringify(nav.destination)}`);
        check('and the champion goes where the key points, not where the click did',
            took !== null && took.dx === 1 && took.dz === 0, JSON.stringify(took));
        check('with no order standing, an idle tick steers nowhere',
            nav.steer(0, 0, STEP, idle) === null);

        // W and S together are two keys held that add up to nothing. That is
        // still the player steering, which is why the cancel keys off the keys
        // rather than off the direction they produce.
        nav.order(0, 0, 0, 8);
        const opposed = nav.steer(0, 0, STEP, { active: true, direction: null });
        check('two opposing keys cancel the destination just the same',
            opposed === null && nav.destination === null,
            `destination=${JSON.stringify(nav.destination)}`);
    }

    // Orders that land somewhere a champion cannot stand are moved, not
    // refused: an order that silently does nothing is indistinguishable from a
    // dropped click.
    {
        const outside = nav.order(0, 0, 99, 99);
        check('an order outside the lane is clamped into it',
            outside.x === LANE_WIDTH_HALF && outside.z === LANE_MAX_Z,
            `(${outside.x}, ${outside.z})`);

        const onTower = nav.order(0, 4, 0, TOWER_INNER_Z);
        const gap = Math.hypot(onTower.x, onTower.z - TOWER_INNER_Z);
        check('an order on top of a tower is pushed to its rim',
            Math.abs(gap - (TOWER_RADIUS + CHAMPION_RADIUS)) < 0.01 && onTower.z < TOWER_INNER_Z,
            `${gap.toFixed(2)} out, on the ${onTower.z < TOWER_INNER_Z ? 'near' : 'far'} side`);
    }

    // A path is drawn against the board as it stood. Towers fall mid-order, and
    // the arena is rebuilt between matches.
    {
        nav.order(0, 4, 0, 10);
        const before = nav.steer(0, 4, STEP, idle);
        nav.syncBlockers(board.filter((unit) => unit.z !== TOWER_INNER_Z));
        const after = nav.steer(0, 4, STEP, idle);
        check('a standing order is re-planned when the structure it avoided falls',
            before !== null && after !== null
                && Math.abs(before.dx) > 0.05 && Math.abs(after.dx) < 0.01,
            `dx ${before?.dx.toFixed(3)} -> ${after?.dx.toFixed(3)}`);
    }

    remove(...board.map((unit) => unit.entity));
    await waitSeconds(0.1);
}

arena.loop.stop();

console.log(`\n${results.join('\n')}`);
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
