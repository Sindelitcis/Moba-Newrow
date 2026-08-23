import {
    LANE_HALF,
    LANE_WIDTH_HALF,
    SPAWN_AREA_DEPTH,
    TEAMS,
    baseZ,
    forwardZ,
} from '../../shared';
import { teamCssColor, visualFor } from './unit-visuals';
import type { UnitSnapshot } from './world-view';

/**
 * The lane, seen from above.
 *
 * Every MOBA has one, and for the same reason: the chase camera can see about
 * a third of the lane at a time, so without a minimap "where is the enemy
 * wave, and is anything hitting my tower right now" is unanswerable without
 * walking there. It is drawn from data the client already has: nothing here
 * touches the wire.
 *
 * SVG rather than canvas: perhaps forty blips at 20 Hz, each a `<circle>` or
 * `<rect>` whose `cx`/`cy` are the only thing that changes. The elements are
 * pooled and reused between ticks so a redraw is a handful of attribute
 * writes, not a fresh DOM tree.
 *
 * Always drawn from the *viewer's* perspective: your base at the bottom,
 * theirs at the top, which matches the camera and, more importantly, matches
 * what "forward" means on the keyboard. A fixed orientation would have team A
 * reading their own minimap upside down, which is precisely the bug the
 * `forwardZ` helper exists to prevent everywhere else.
 */
export interface Minimap {
    /** Redraws for `units`, oriented for `myTeam`, marking `self`. */
    update(units: readonly UnitSnapshot[], myTeam: number | null, self: number | null): void;
    setVisible(visible: boolean): void;
    dispose(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Rendered size of the map, in px. Also the SVG's viewBox, so 1 unit = 1 px. */
const SIZE = 168;
/** Padding inside the frame, so a unit at the very edge is still fully drawn. */
const PADDING = 8;

/** World half-extent the map covers along Z, including the spawn areas behind each base. */
const WORLD_HALF_Z = LANE_HALF + SPAWN_AREA_DEPTH;
/** …and along X. Wider than the lane so the side walls have somewhere to sit. */
const WORLD_HALF_X = LANE_WIDTH_HALF + 2.5;

interface Blip {
    element: SVGCircleElement | SVGRectElement;
    square: boolean;
}

export function createMinimap(container: HTMLElement): Minimap {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'minimap');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('width', String(SIZE));
    svg.setAttribute('height', String(SIZE));

    // Static backdrop: the lane corridor plus a tinted band at each end. Drawn
    // once; only the blips above it change.
    const lane = document.createElementNS(SVG_NS, 'rect');
    lane.setAttribute('class', 'minimap-lane');
    lane.setAttribute('x', String(project(-LANE_WIDTH_HALF, WORLD_HALF_X)));
    lane.setAttribute('y', String(PADDING));
    lane.setAttribute('width', String(project(LANE_WIDTH_HALF, WORLD_HALF_X) - project(-LANE_WIDTH_HALF, WORLD_HALF_X)));
    lane.setAttribute('height', String(SIZE - PADDING * 2));
    svg.appendChild(lane);

    /** The two end-zone bands, re-tinted per tick because which end is "mine" flips. */
    const bands = TEAMS.map(() => {
        const band = document.createElementNS(SVG_NS, 'rect');
        band.setAttribute('class', 'minimap-band');
        band.setAttribute('x', String(PADDING));
        band.setAttribute('width', String(SIZE - PADDING * 2));
        band.setAttribute('height', String(SIZE * 0.16));
        svg.appendChild(band);
        return band;
    });

    const blipLayer = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(blipLayer);
    container.appendChild(svg);

    const pool: Blip[] = [];

    /** Borrows blip `index`, creating (and re-creating, on a shape change) as needed. */
    function takeBlip(index: number, square: boolean): Blip {
        const existing = pool[index];
        if (existing !== undefined && existing.square === square) return existing;

        existing?.element.remove();
        const element = document.createElementNS(SVG_NS, square ? 'rect' : 'circle');
        blipLayer.appendChild(element);
        const blip: Blip = { element, square };
        pool[index] = blip;
        return blip;
    }

    return {
        update(units, myTeam, self) {
            // Before the first `assigned`, there is no "my side" to orient to;
            // fall back to team A's view rather than flipping once it arrives.
            const viewer = myTeam ?? TEAMS[0];
            // Your own base at the bottom of the map: screen-down must be the
            // direction you retreat in, which is -forwardZ.
            const flip = forwardZ(viewer);

            for (const team of TEAMS) {
                const band = bands[team];
                const top = mapZ(baseZ(team), flip) - SIZE * 0.08;
                band.setAttribute('y', String(top));
                band.setAttribute('fill', teamCssColor(team));
                band.setAttribute('opacity', '0.14');
            }

            let drawn = 0;
            for (const unit of units) {
                const shape = visualFor(unit.kind).blip;
                if (shape === null) continue;

                const blip = takeBlip(drawn++, shape.square);
                const x = mapX(unit.x, flip);
                const y = mapZ(unit.z, flip);
                const isSelf = unit.entity === self;
                // Your own champion is the one blip that has to be findable at a
                // glance, so it is drawn bigger and gets its own outline.
                const radius = isSelf ? shape.radius * 1.5 : shape.radius;

                if (shape.square) {
                    const rect = blip.element as SVGRectElement;
                    rect.setAttribute('x', String(x - radius));
                    rect.setAttribute('y', String(y - radius));
                    rect.setAttribute('width', String(radius * 2));
                    rect.setAttribute('height', String(radius * 2));
                } else {
                    const circle = blip.element as SVGCircleElement;
                    circle.setAttribute('cx', String(x));
                    circle.setAttribute('cy', String(y));
                    circle.setAttribute('r', String(radius));
                }

                blip.element.setAttribute('fill', teamCssColor(unit.team));
                blip.element.setAttribute(
                    'class',
                    isSelf ? 'minimap-blip self' : 'minimap-blip',
                );
                // A structure about to fall is the single most useful thing a
                // minimap can tell you, so it dims as it loses health.
                blip.element.setAttribute('opacity', String(0.45 + unit.hpFraction * 0.55));
                blip.element.style.display = '';
            }

            for (let i = drawn; i < pool.length; i++) pool[i].element.style.display = 'none';
        },

        setVisible(visible) {
            svg.style.display = visible ? '' : 'none';
        },

        dispose() {
            svg.remove();
            pool.length = 0;
        },
    };
}

/** Maps a world coordinate in `[-half, half]` onto the padded map. */
function project(value: number, half: number): number {
    const t = (value + half) / (half * 2);
    return PADDING + t * (SIZE - PADDING * 2);
}

function mapX(x: number, flip: 1 | -1): number {
    // X flips with Z: turning the map around turns both axes, the same way the
    // camera's A/D flip does (see scene.ts).
    return project(x * -flip, WORLD_HALF_X);
}

function mapZ(z: number, flip: 1 | -1): number {
    // Screen Y grows downward, so forward (toward the enemy) is up the map.
    return project(z * -flip, WORLD_HALF_Z);
}
