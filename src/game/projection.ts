/**
 * Between world space and the screen, in both directions.
 *
 * `Camera3D` has no `project()`/`worldToScreen()` helper and no `unproject()`
 * either, but it does expose the raw view-projection matrix, a standard
 * column-major 4x4, so both directions are the usual clip-space arithmetic done
 * by hand: forward for the DOM overlays, backwards for click-to-move.
 */
export interface ScreenPoint {
    x: number;
    y: number;
}

/** A point on the ground plane (y = 0), which is the only plane anything stands on. */
export interface GroundPoint {
    x: number;
    z: number;
}

/** Returns null for points at or behind the camera plane, which have no screen position. */
export function worldToScreen(
    vp: Float32Array,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
): ScreenPoint | null {
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.0001) return null;
    return {
        x: (cx / cw * 0.5 + 0.5) * width,
        y: (1 - (cy / cw * 0.5 + 0.5)) * height,
    };
}

/**
 * The inverse of `worldToScreen`, restricted to the ground: which point of the
 * plane y = 0 sits under a given pixel.
 *
 * A pixel names a ray, not a point, so recovering a world position needs a
 * surface to stop the ray at. Everything in this game stands on y = 0 and
 * nothing jumps, so that plane is the whole answer: unproject the pixel at two
 * different clip depths to get two points on its ray, then intersect.
 *
 * Which two depths does not matter, and that is worth knowing: for a fixed
 * pixel every clip depth maps onto the same ray, so the choice of 0 and 1 needs
 * no assumption about whether the projection matrix hands back WebGPU's [0, 1]
 * depth range or OpenGL's [-1, 1].
 *
 * Returns null when the ray never reaches the ground: parallel to it, or
 * pointing away from it, which is what a click on the horizon means.
 */
export function screenToGround(
    vp: Float32Array,
    screenX: number,
    screenY: number,
    width: number,
    height: number,
): GroundPoint | null {
    if (width <= 0 || height <= 0) return null;

    const inverse = invert(vp);
    if (inverse === null) return null;

    const ndcX = (screenX / width) * 2 - 1;
    const ndcY = 1 - (screenY / height) * 2;
    const near = unproject(inverse, ndcX, ndcY, 0);
    const far = unproject(inverse, ndcX, ndcY, 1);
    if (near === null || far === null) return null;

    const rise = far.y - near.y;
    if (Math.abs(rise) < 1e-6) return null;

    const t = -near.y / rise;
    if (t < 0 || !Number.isFinite(t)) return null;

    return {
        x: near.x + (far.x - near.x) * t,
        z: near.z + (far.z - near.z) * t,
    };
}

interface WorldPoint {
    x: number;
    y: number;
    z: number;
}

/** One clip-space point back to world space, through the inverse matrix. */
function unproject(inverse: Float64Array, x: number, y: number, z: number): WorldPoint | null {
    const wx = inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12];
    const wy = inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13];
    const wz = inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14];
    const ww = inverse[3] * x + inverse[7] * y + inverse[11] * z + inverse[15];
    if (ww === 0 || !Number.isFinite(ww)) return null;
    return { x: wx / ww, y: wy / ww, z: wz / ww };
}

/**
 * Inverse of a 4x4, by cofactor expansion, or null if it is singular.
 *
 * In double precision rather than the `Float32Array` it is handed: inverting a
 * perspective matrix subtracts nearly equal products, and at f32 the result is
 * accurate enough to place a health bar but visibly wrong tens of units down
 * the lane, where a click-to-move order most often lands.
 */
function invert(m: Float32Array): Float64Array | null {
    const inv = new Float64Array(16);

    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15]
        + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15]
        - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15]
        + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14]
        - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15]
        - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15]
        + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15]
        - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14]
        + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15]
        + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15]
        - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15]
        + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14]
        - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11]
        - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11]
        + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11]
        - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10]
        + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

    const determinant = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (determinant === 0 || !Number.isFinite(determinant)) return null;

    const scale = 1 / determinant;
    for (let i = 0; i < 16; i++) inv[i] *= scale;
    return inv;
}
