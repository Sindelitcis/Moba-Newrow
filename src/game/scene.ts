import type { PrefabBucket } from 'murow';
import type { WebGPU3DRenderer } from 'murow/webgpu';
import { LANE_HALF, LANE_WIDTH_HALF, SPAWN_AREA_DEPTH, TEAMS, baseZ, forwardZ } from '../../shared';
import { TEAM_COLOR } from './unit-visuals';

/**
 * Chase-camera offset from the local champion. Pulled up and back from the
 * original 16/10: at that distance a 4.5-unit tower the camera passes over
 * filled most of the frame, which reads as the tower being mis-scaled when
 * it's really just the framing. Roughly the same ~55deg pitch, ~1.5x further
 * out, so more of the lane is legible at once.
 */
const CAMERA_HEIGHT = 20;
const CAMERA_BACK = 13;

/**
 * Points the camera at `[x, z]` from behind, where "behind" is relative to
 * the team's own base.
 *
 * This is the whole fix for team A playing the map backwards: the camera
 * used to sit at a fixed `+Z` offset and always look down `-Z`, which only
 * points at the enemy if you spawned at `+Z` (team B). Deriving the offset
 * from `forwardZ(team)` makes both teams look down the lane at the enemy,
 * and, because the controls derive their axes from the same helper, keeps
 * "W" meaning "away from the camera" for both.
 */
export function updateCamera(renderer: WebGPU3DRenderer, team: number, x: number, z: number): void {
    const back = forwardZ(team) * CAMERA_BACK;
    renderer.camera.setPosition(x, CAMERA_HEIGHT, z - back);
    renderer.camera.setTarget(x, 0, z);
}

/** Camera framing and lighting. Applied once, right after the renderer inits. */
export function configureScene(renderer: WebGPU3DRenderer): void {
    renderer.camera.fov = 55;
    renderer.camera.near = 0.05;
    // Raised along with the camera pull-back: the far plane has to clear the
    // whole diagonal of the (now much larger) floor, or its far corners get
    // clipped away mid-frame.
    renderer.camera.far = 250;

    // The renderer's defaults (white sun at intensity 1, ambient 0.3 grey)
    // wash the models out flat. A warm sun slightly off-axis gives the towers
    // and champions readable shading, and a cool low ambient keeps the shadow
    // side in the same blue family as the clear color instead of going muddy.
    renderer.setDirectionalLight([0.4, 0.9, 0.35], [1.0, 0.94, 0.82], 1.15);
    renderer.setAmbient([0.28, 0.32, 0.44]);

    // Team-colored glow over each base: cheap atmosphere, and it makes which
    // half of the lane you're standing in readable at a glance.
    for (const team of TEAMS) {
        renderer.addLight({
            type: 'point',
            position: [0, 5, baseZ(team)],
            color: TEAM_COLOR[team] as [number, number, number],
            intensity: 14,
            range: 22,
        });
    }
}

/**
 * Static scenery: a solid ground slab, the lane running down the middle, and
 * low side walls framing it.
 *
 * This replaces the original wireframe `grid` prefab, which read as a
 * floating blueprint rather than a floor. Everything here is the plain `unit`
 * cube scaled per instance: Murow's 3D prefabs are only `gltf` / `grid` /
 * `cube` / `composite` (there is no plane or terrain primitive), and `cube`
 * carries no texture, so flat-shaded boxes lit by the directional light are
 * the whole toolkit until a real GLTF ground model is added.
 *
 * Layers are stacked in fractions of a unit (ground top at y=0, lane at
 * +0.04, markings at +0.09) rather than sharing a plane: coplanar faces
 * would z-fight. The gaps are far larger than the depth buffer's precision at
 * this camera distance, so the ordering is stable.
 */
export function buildArena(renderer: WebGPU3DRenderer, prefabs: PrefabBucket): void {
    const cube = prefabs.get('unit');
    const slab = (
        color: [number, number, number],
        position: [number, number, number],
        scale: [number, number, number],
    ) => renderer.addInstance({ model: cube, color, position, scale });

    // Ground. Deliberately much wider than the playable area so its edge never
    // enters frame with the pulled-back chase camera.
    const GROUND = 130;
    slab([0.11, 0.13, 0.19], [0, -0.5, 0], [GROUND, 1, GROUND]);

    // The lane itself, a shade lighter so the walkable corridor reads even
    // where no units are standing.
    //
    // Long enough to run past both spawn areas *and* past where the chase
    // camera sits behind a champion standing in one (`CAMERA_BACK`): at the
    // old length the near edge of the lane slab was in frame the moment you
    // respawned, so the map appeared to end in a void a few metres behind you.
    const LANE_LENGTH = (LANE_HALF + SPAWN_AREA_DEPTH + CAMERA_BACK + 4) * 2;
    const LANE_W = LANE_WIDTH_HALF * 2 + 3;
    slab([0.17, 0.20, 0.27], [0, 0.04, 0], [LANE_W, 0.08, LANE_LENGTH]);

    // Lane edging + rungs every 5 units. Without some repeating marking the
    // ground is a flat void and champion movement has no visual reference to
    // read speed against: this is what the old grid was accidentally providing.
    const EDGE_X = LANE_WIDTH_HALF + 1.5;
    for (const x of [-EDGE_X, EDGE_X]) {
        slab([0.30, 0.35, 0.44], [x, 0.09, 0], [0.22, 0.1, LANE_LENGTH]);
    }
    for (let z = -LANE_HALF; z <= LANE_HALF; z += 5) {
        slab([0.22, 0.26, 0.33], [0, 0.09, z], [LANE_W, 0.1, 0.14]);
    }
    // Mid-lane, marked brighter and wider than the rungs. It is where the two
    // waves meet, so it is the one line on the ground worth being able to see
    // from either end.
    slab([0.45, 0.52, 0.62], [0, 0.1, 0], [LANE_W + 2, 0.1, 0.3]);

    // Team-tinted aprons in front of each base, so which half of the lane
    // you're standing in is readable at a glance.
    for (const team of TEAMS) {
        const [r, g, b] = TEAM_COLOR[team] ?? [0.5, 0.5, 0.5];
        slab([r * 0.32, g * 0.32, b * 0.32], [0, 0.06, baseZ(team)], [LANE_W + 4, 0.1, 11]);
    }

    // Side walls: two long boxes instead of a row of free-standing pillars,
    // which looked like scattered debris from the chase camera.
    const WALL_X = LANE_WIDTH_HALF + 2.6;
    for (const x of [-WALL_X, WALL_X]) {
        slab([0.15, 0.17, 0.23], [x, 0.7, 0], [0.9, 1.4, LANE_LENGTH]);
    }
    // Posts break up the wall's silhouette so it doesn't read as one extruded bar.
    const postEnd = LANE_LENGTH / 2 - 2;
    for (let z = -postEnd; z <= postEnd; z += 8) {
        for (const x of [-WALL_X, WALL_X]) {
            slab([0.24, 0.27, 0.34], [x, 1.05, z], [1.25, 2.1, 1.25]);
        }
    }
}
