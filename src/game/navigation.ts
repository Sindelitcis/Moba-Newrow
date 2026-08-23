import { NavMesh, type Entity } from 'murow';
import {
    BASE_RADIUS,
    CHAMPION_RADIUS,
    KIND_BASE,
    LANE_MAX_Z,
    LANE_WIDTH_HALF,
    MOVE_SPEED,
    TOWER_RADIUS,
    clampToLane,
    isStructure,
    normalize,
    type Point2,
} from '../../shared';

/**
 * Where the champion is walking this tick, and which of the two input schemes
 * decides that.
 *
 * WASD is stateless: a direction every tick while the keys are held, and
 * nothing at all once they come up. Click-to-move is stateful: one right click,
 * then seconds of walking with no further input. This module owns the state the
 * second one needs, the pathfinding that produces it, and the rule that stops
 * the two from steering the same champion at once.
 *
 * ## Where the destination lives, and why
 *
 * On the client, and nowhere else: not a networked component, and not something
 * the server recomputes per tick.
 *
 * The networked-component version has the server steering from the destination
 * too, which means both sides deriving a direction from a path. But
 * `definePredictions` replays the same movement function on both, so any
 * disagreement about that path is a disagreement about the champion's position:
 * an obstacle set that differs for one tick, a float that rounds the other way,
 * a tower that fell on the server first. Reconciliation then corrects the
 * position by snapping it, and the movement visibly trembles. The path is the
 * fragile part, so it is computed on one machine only.
 *
 * What crosses the wire is therefore unchanged: one `move` intent per tick
 * carrying a direction, which is exactly what a held key already produces. The
 * server cannot tell a click order from a key press, the prediction stays the
 * pure function of (state, payload, deltaTime) it has to be, and the bot goes
 * on steering through `stepChampion` untouched. Trusting the direction grants
 * nothing new either, for the same reason the `dash` intent gives for accepting
 * one: a player can already walk in any direction, so naming one is not new
 * authority.
 *
 * The cost is that a client which stops sending intents stops walking, which is
 * already true of WASD, and that the server cannot draw the path. Neither
 * matters here; a desynchronised champion would.
 */

export interface SteeringDirection {
    dx: number;
    dz: number;
}

/** What the movement keys are asking for this tick. */
export interface ManualInput {
    /**
     * Whether any movement key is held.
     *
     * Deliberately not `direction !== null`: W and S together are two keys held
     * that add up to nothing, and that is still the player steering by hand.
     */
    active: boolean;
    /** The world direction they add up to, or null when they cancel out. */
    direction: SteeringDirection | null;
}

/**
 * One unit as the navigator needs to see it. `WorldView`'s per-tick snapshots
 * satisfy this, which is the point: the board has already been walked once.
 */
export interface NavUnit {
    entity: Entity;
    kind: number;
    x: number;
    z: number;
}

export interface Navigator {
    /** Refreshes the obstacle set from the units currently on the board. */
    syncBlockers(units: readonly NavUnit[]): void;
    /**
     * Orders a walk to `(toX, toZ)`, routed around whatever stands in the way.
     *
     * Returns the destination actually taken: clamped into the lane, and pushed
     * clear of any structure the click landed on.
     */
    order(fromX: number, fromZ: number, toX: number, toZ: number): Point2;
    /** Drops any standing order. */
    cancel(): void;
    /** Where the champion is currently headed, or null when it is not. */
    readonly destination: Point2 | null;
    /**
     * The direction to walk this tick, or null to stand still.
     *
     * The single place the two schemes are arbitrated, so there is one answer
     * per tick rather than two systems writing the same position.
     */
    steer(x: number, z: number, deltaTime: number, manual: ManualInput): SteeringDirection | null;
}

/** How close counts as having rounded an intermediate corner. */
const WAYPOINT_RADIUS = 0.3;

/**
 * Thickness of the walls that fence the navmesh into the walkable area.
 *
 * Wider than one unit on purpose: the grid search samples one point per unit
 * cell, so a wall thinner than a cell can be stepped straight over by a cell
 * whose centre happens to land past it.
 */
const BOUNDS_THICKNESS = 2;

/** A structure the champion has to walk around. */
interface Blocker {
    obstacle: number;
    x: number;
    z: number;
    radius: number;
    /** Sync pass that last saw it. Anything older has been destroyed. */
    seen: number;
}

/**
 * Radius the pathfinder should treat a structure as having.
 *
 * The champion's own radius is added because the navmesh routes a point, not a
 * body: a path that grazes a tower is a path that walks a champion's shoulder
 * through it, and collision then shoves it back out. Inflating the obstacle
 * instead is the standard fix and keeps the two agreeing.
 */
function blockerRadius(kind: number): number {
    return (kind === KIND_BASE ? BASE_RADIUS : TOWER_RADIUS) + CHAMPION_RADIUS;
}

/**
 * The pathfinder and the standing order, for one session.
 *
 * Per session rather than per client for the same reason the world view is:
 * blockers are keyed by entity id, and ids only mean anything relative to the
 * `World` they came from.
 */
export function createNavigator(): Navigator {
    /**
     * `graph`, not `grid`: the lane is an open corridor, so most orders have
     * clear line of sight and `findPath` answers with the two endpoints
     * unchanged. Grid mode would snap even those to 1-unit cell centres and
     * hand back a 4-connected staircase across empty ground. Graph mode falls
     * back to that same grid search only when something is actually in the way,
     * which is where a staircase is worth having and where `simplify` below
     * straightens it back out.
     *
     * `workers: false` is stated rather than left to the default because it is
     * load-bearing: this runs inside the tick and needs its answer now, and the
     * worker-backed overload returns a Promise.
     */
    const nav = new NavMesh('graph', { workers: false });

    const blockers = new Map<Entity, Blocker>();
    /** Bumped whenever the obstacle set changes, which invalidates a planned path. */
    let revision = 0;
    let syncPass = 0;

    let destination: Point2 | null = null;
    /**
     * The legs still to walk, and which one is current.
     *
     * Emptied in place rather than replaced: `cancel` runs on every tick the
     * player is steering by hand, which is most of them, and a fresh array per
     * tick for a list that is almost always already empty is pure litter.
     */
    const waypoints: Point2[] = [];
    let cursor = 0;
    let plannedRevision = -1;

    fenceTheLane();

    /**
     * Walls the navmesh into the same rectangle `clampToLane` enforces.
     *
     * Without them the grid search runs on an unbounded plane: it would happily
     * route around a tower through ground the champion is then clamped out of,
     * and an unreachable goal would have it expanding cells forever instead of
     * failing.
     */
    function fenceTheLane(): void {
        const outerX = LANE_WIDTH_HALF + BOUNDS_THICKNESS;
        const outerZ = LANE_MAX_Z + BOUNDS_THICKNESS;
        const sides: { x: number; z: number; width: number; depth: number }[] = [
            { x: -outerX, z: -outerZ, width: BOUNDS_THICKNESS, depth: outerZ * 2 },
            { x: LANE_WIDTH_HALF, z: -outerZ, width: BOUNDS_THICKNESS, depth: outerZ * 2 },
            { x: -outerX, z: -outerZ, width: outerX * 2, depth: BOUNDS_THICKNESS },
            { x: -outerX, z: LANE_MAX_Z, width: outerX * 2, depth: BOUNDS_THICKNESS },
        ];
        // The navmesh is 2D and calls its second axis `y`; here that is world Z.
        for (const side of sides) {
            nav.addObstacle({
                type: 'rect',
                pos: { x: side.x, y: side.z },
                size: { x: side.width, y: side.depth },
            });
        }
    }

    /**
     * Whether the straight segment between two points is clear.
     *
     * Asked of the navmesh rather than re-derived from the obstacle list: in
     * `graph` mode `findPath` hands back its two arguments unchanged when
     * nothing blocks the ray between them, and something else when something
     * does, so the identity of the far endpoint is the answer.
     */
    function hasLineOfSight(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
        const path = nav.findPath({ from: { x: fromX, y: fromZ }, to: { x: toX, y: toZ } });
        return path.length === 2 && path[1].x === toX && path[1].y === toZ;
    }

    /**
     * Reduces the raw path to the corners that actually need turning.
     *
     * The grid fallback is 4-connected over cell centres, so its output is a
     * staircase, and a champion walking it literally zigzags across open ground.
     * Keeping only the farthest node still in line of sight from the last corner
     * turns that back into the straight legs a player would have walked.
     */
    function simplify(fromX: number, fromZ: number, raw: readonly { x: number; y: number }[]): void {
        let anchorX = fromX;
        let anchorZ = fromZ;

        for (let i = 0; i < raw.length; ) {
            let farthest = i;
            for (let k = raw.length - 1; k > i; k--) {
                if (hasLineOfSight(anchorX, anchorZ, raw[k].x, raw[k].y)) {
                    farthest = k;
                    break;
                }
            }
            anchorX = raw[farthest].x;
            anchorZ = raw[farthest].y;
            waypoints.push({ x: anchorX, z: anchorZ });
            i = farthest + 1;
        }
    }

    function plan(fromX: number, fromZ: number): void {
        waypoints.length = 0;
        cursor = 0;
        plannedRevision = revision;
        if (destination === null) return;

        const raw = nav.findPath({
            from: { x: fromX, y: fromZ },
            to: { x: destination.x, y: destination.z },
        });

        // No route at all means the champion is standing inside an inflated
        // radius with every neighbouring cell blocked, which collision
        // push-apart undoes within a tick or two. Heading straight at the
        // destination meanwhile is right rather than merely harmless: the lane
        // is a corridor with no dead ends to get wedged in.
        if (raw.length === 0) {
            waypoints.push({ x: destination.x, z: destination.z });
            return;
        }

        simplify(fromX, fromZ, raw);

        // The grid fallback finishes on the goal *cell's centre*, and the click
        // was somewhere inside that cell. End on the point the player asked for.
        const last = waypoints[waypoints.length - 1];
        if (last !== undefined) {
            last.x = destination.x;
            last.z = destination.z;
        }
    }

    /**
     * Moves a destination that landed on a structure out to its rim.
     *
     * Pushed rather than refused: clicking a tower means "go to that tower", and
     * an order that silently does nothing is indistinguishable from a dropped
     * input. The bearing is the click's own, so clicking past a structure still
     * means the far side of it; the champion's bearing is the fallback for a
     * click exactly on the centre, where there is no bearing to preserve.
     */
    function pushClear(point: Point2, fromX: number, fromZ: number): Point2 {
        for (const blocker of blockers.values()) {
            const dx = point.x - blocker.x;
            const dz = point.z - blocker.z;
            const distance = Math.hypot(dx, dz);
            if (distance >= blocker.radius) continue;

            const bearing = normalize(dx, dz)
                ?? normalize(fromX - blocker.x, fromZ - blocker.z)
                ?? { dx: 1, dz: 0 };
            return clampToLane(
                blocker.x + bearing.dx * blocker.radius,
                blocker.z + bearing.dz * blocker.radius,
            );
        }
        return point;
    }

    function cancel(): void {
        destination = null;
        waypoints.length = 0;
        cursor = 0;
    }

    return {
        get destination() {
            return destination;
        },

        syncBlockers(units) {
            // Mark and sweep against a pass counter rather than diffing against
            // a fresh Set every tick: structures are six entities, and this runs
            // twenty times a second.
            syncPass++;
            for (const unit of units) {
                if (!isStructure(unit.kind)) continue;

                const known = blockers.get(unit.entity);
                if (known !== undefined) {
                    known.seen = syncPass;
                    continue;
                }
                // Structures never move, so an obstacle is added once and only
                // removed when the thing it stands for is destroyed.
                const radius = blockerRadius(unit.kind);
                blockers.set(unit.entity, {
                    obstacle: nav.addObstacle({
                        type: 'circle',
                        pos: { x: unit.x, y: unit.z },
                        radius,
                    }),
                    x: unit.x,
                    z: unit.z,
                    radius,
                    seen: syncPass,
                });
                revision++;
            }

            for (const [entity, blocker] of blockers) {
                if (blocker.seen === syncPass) continue;
                nav.removeObstacle(blocker.obstacle);
                blockers.delete(entity);
                revision++;
            }
        },

        order(fromX, fromZ, toX, toZ) {
            destination = pushClear(clampToLane(toX, toZ), fromX, fromZ);
            plan(fromX, fromZ);
            return destination;
        },

        cancel,

        steer(x, z, deltaTime, manual) {
            // WASD wins outright, and takes the standing order with it. This is
            // the whole reason the arbitration lives here: leaving both live
            // means two systems writing one position from different ideas of
            // where it should go, which is the only way they can genuinely
            // fight. Held keys, not fresh presses, so a destination cannot
            // survive underneath a player who has taken over by hand.
            if (manual.active) {
                cancel();
                return manual.direction;
            }
            if (destination === null) return null;

            // A structure fell, or the arena was rebuilt: the path was drawn
            // around a board that no longer exists.
            if (revision !== plannedRevision) plan(x, z);

            const step = MOVE_SPEED * deltaTime;
            while (cursor < waypoints.length) {
                const target = waypoints[cursor];
                const dx = target.x - x;
                const dz = target.z - z;
                const distance = Math.hypot(dx, dz);
                const isLast = cursor === waypoints.length - 1;

                // The last leg stops a whole step short instead of overshooting
                // and stepping back: `stepChampion` always travels a full tick's
                // worth, so an exact arrival is a champion vibrating on the spot.
                // One step is 0.2 units, well inside the champion's own radius.
                if (distance > (isLast ? step : WAYPOINT_RADIUS)) {
                    return { dx: dx / distance, dz: dz / distance };
                }
                if (isLast) break;
                cursor++;
            }

            cancel();
            return null;
        },
    };
}
