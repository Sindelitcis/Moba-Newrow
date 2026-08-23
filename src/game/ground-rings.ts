import { worldToScreen } from './projection';

/**
 * Circles painted flat on the ground: your attack range, and the reach of any
 * enemy tower you have wandered into.
 *
 * Drawn as SVG polygons of projected ground points rather than 3D geometry: the
 * renderer's only primitives are cubes and GLTF models, so a real ring would
 * cost ~32 instances of the shared instance budget *each* and still not hug the
 * ground properly. Projecting the circle instead costs nothing and is exact
 * under the camera's perspective, including the foreshortening that turns it
 * into an ellipse.
 *
 * The first two exist to answer a question the game otherwise makes you learn
 * by dying:
 *
 * - **Attack range**: a swing needs the cursor over an enemy that is *also* in
 *   reach, and the ring brightening is what teaches that rule.
 * - **Tower range**: shown only while you are actually inside one, because a
 *   danger zone you are not in is not information, it is clutter. Appearing at
 *   all *is* the warning; the ring then tells you which way is out.
 * - **Move target**: where a click-to-move order is headed. That order runs for
 *   seconds with no further input, so it is the one thing on screen that says
 *   the click was received and the champion is not simply stuck.
 */
export type RingStyle = 'attack' | 'attack-ready' | 'tower-danger' | 'move-target';

export interface GroundRing {
    x: number;
    z: number;
    radius: number;
    style: RingStyle;
}

export interface GroundRings {
    /** Redraws every ring for this frame. An empty list clears the layer. */
    sync(vp: Float32Array, rings: readonly GroundRing[], width: number, height: number): void;
    clear(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Points around each circle. 32 is smooth at any zoom this camera reaches. */
const SEGMENTS = 32;
/**
 * Height above the floor, matching the lane markings so a ring doesn't sink
 * into the ground slab.
 */
const RING_Y = 0.1;

export function createGroundRings(container: HTMLElement): GroundRings {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ground-rings');
    container.appendChild(svg);

    const pool: SVGPolygonElement[] = [];

    function takePolygon(index: number): SVGPolygonElement {
        let polygon = pool[index];
        if (polygon === undefined) {
            polygon = document.createElementNS(SVG_NS, 'polygon');
            svg.appendChild(polygon);
            pool[index] = polygon;
        }
        return polygon;
    }

    /** Projects one ring, or returns null if any of it falls behind the camera. */
    function project(
        vp: Float32Array,
        ring: GroundRing,
        width: number,
        height: number,
    ): string | null {
        const points: string[] = [];
        for (let i = 0; i < SEGMENTS; i++) {
            const angle = (i / SEGMENTS) * Math.PI * 2;
            const screen = worldToScreen(
                vp,
                ring.x + Math.cos(angle) * ring.radius,
                RING_Y,
                ring.z + Math.sin(angle) * ring.radius,
                width,
                height,
            );
            // Any point behind the camera makes the whole polygon meaningless -
            // bail rather than draw a folded shape.
            if (screen === null) return null;
            points.push(`${screen.x.toFixed(1)},${screen.y.toFixed(1)}`);
        }
        return points.join(' ');
    }

    return {
        sync(vp, rings, width, height) {
            let drawn = 0;
            for (const ring of rings) {
                const points = project(vp, ring, width, height);
                if (points === null) continue;

                const polygon = takePolygon(drawn++);
                polygon.setAttribute('points', points);
                polygon.setAttribute('class', `ground-ring ${ring.style}`);
                polygon.style.display = '';
            }
            for (let i = drawn; i < pool.length; i++) pool[i].style.display = 'none';
        },

        clear() {
            for (const polygon of pool) polygon.style.display = 'none';
        },
    };
}
