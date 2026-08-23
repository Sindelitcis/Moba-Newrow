import type { PrefabBucket } from 'murow';
import type { InstanceHandle, WebGPU3DRenderer } from 'murow/webgpu';

/**
 * The base, assembled from plain cubes.
 *
 * Every other structure is a real GLTF model, but there's no suitable base
 * model in `public/models/` and adding one means sourcing a licensed asset -
 * so this builds a stepped nexus out of the same `unit` cube the arena floor
 * uses: two platform tiers, four corner pillars, and a team-colored core
 * floating above them. Reads as a *place* rather than the single flat box it
 * used to be, at a cost of 7 instances per base.
 *
 * The core is the base entity's own instance (see unit-visuals.ts) so that
 * the HP bar, hover hit-testing and hit flashes all track the thing a player
 * actually aims at; everything below it is static decoration created and
 * destroyed alongside the entity.
 *
 * `NEXUS_CORE_Y + NEXUS_CORE_SIZE / 2` is the top of the assembly and should
 * stay in step with `UNIT_HEIGHT_BASE`, which is where the HP bar floats.
 */

/** Edge length of the floating core cube: the base entity's own instance. */
export const NEXUS_CORE_SIZE = 1.7;
/** Height of the core's center above the ground. */
export const NEXUS_CORE_Y = 2.15;

const TIER_LOW = { size: 4.6, height: 0.5 };
const TIER_HIGH = { size: 3.4, height: 0.45 };
const PILLAR = { size: 0.45, height: 2.0, offset: 1.55 };

/**
 * Spawns the static decoration around a base at `[x, z]`. The returned
 * handles are the caller's to destroy when the base entity goes away.
 */
export function buildNexus(
    renderer: WebGPU3DRenderer,
    prefabs: PrefabBucket,
    teamColor: readonly [number, number, number],
    x: number,
    z: number,
): InstanceHandle[] {
    const [r, g, b] = teamColor;
    const cube = prefabs.get('unit');

    const slab = (
        shade: number,
        position: [number, number, number],
        scale: [number, number, number],
    ) => renderer.addInstance({
        model: cube,
        color: [r * shade, g * shade, b * shade],
        position,
        scale,
    });

    const parts: InstanceHandle[] = [
        slab(0.3, [x, TIER_LOW.height / 2, z], [TIER_LOW.size, TIER_LOW.height, TIER_LOW.size]),
        slab(
            0.45,
            [x, TIER_LOW.height + TIER_HIGH.height / 2, z],
            [TIER_HIGH.size, TIER_HIGH.height, TIER_HIGH.size],
        ),
    ];

    const pillarY = TIER_LOW.height + PILLAR.height / 2;
    for (const dx of [-PILLAR.offset, PILLAR.offset]) {
        for (const dz of [-PILLAR.offset, PILLAR.offset]) {
            parts.push(slab(
                0.6,
                [x + dx, pillarY, z + dz],
                [PILLAR.size, PILLAR.height, PILLAR.size],
            ));
        }
    }

    return parts;
}
