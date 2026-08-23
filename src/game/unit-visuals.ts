import {
    GLTF_ROTATION_TOWER,
    GLTF_SCALE_MINION,
    GLTF_SCALE_TOWER,
    KIND_BASE,
    KIND_CHAMPION,
    KIND_MINION,
    KIND_MINION_CASTER,
    KIND_TOWER,
    UNIT_HEIGHT_BASE,
    UNIT_HEIGHT_CHAMPION,
    UNIT_HEIGHT_MINION,
    UNIT_HEIGHT_MINION_CASTER,
    UNIT_HEIGHT_TOWER,
} from '../../shared';
import { NEXUS_CORE_SIZE, NEXUS_CORE_Y } from './nexus';

/** Team A renders blue, team B renders red. */
export const TEAM_COLOR: Record<number, readonly [number, number, number]> = {
    0: [0.3, 0.55, 0.95],
    1: [0.95, 0.35, 0.35],
};

const NEUTRAL_COLOR: readonly [number, number, number] = [0.7, 0.7, 0.7];

/** Everything the renderer and the HUD need to know about how a kind looks. */
export interface UnitVisual {
    /**
     * Prefab id. Everything except the base is a real GLTF model; the base is
     * assembled from plain cubes instead (see nexus.ts), with this instance as
     * its floating core.
     *
     * Champion and minion are *skinned* meshes, which used to be unusable
     * here: `WebGPU3DRenderer.render()` calls `updateAnimations()`
     * unconditionally, and that threw before issuing any draw call, so a
     * single skinned instance anywhere in the scene blanked the whole canvas.
     * Fixed in vite-plugins/patch-murow-typegpu-metadata.ts: see that file.
     */
    readonly modelId: string;
    readonly scale: number | readonly [number, number, number];
    /** Euler rotation (radians) baked into the instance: see GLTF_ROTATION_TOWER. */
    readonly rotation?: readonly [number, number, number];
    /** Y to place the instance's origin at. GLTF models are all feet-at-origin. */
    readonly originY: number;
    /** World-space height, for HP bar placement and hover hit-testing. */
    readonly height: number;
    /**
     * How much of the team color to keep when tinting.
     * `MeshInstanceOptions.color` is a *multiply* over the model's own
     * baseColor texture, so the textured models (champion, minion) need it
     * pulled most of the way back toward white or the multiply crushes all
     * their detail into a flat team-colored silhouette. The tower is GLTF but
     * carries no textures, so it sits in between; the cube-rendered base wants
     * the color at full strength.
     */
    readonly tintKeep: number;
    /** HP bar footprint, scaled by the kind's importance rather than its literal size. */
    readonly barSize: 'sm' | 'md' | 'lg';
    /** Mouse-hover hit radius in CSS px: roughly its on-screen footprint. */
    readonly hitRadiusPx: number;
    /** Minimap blip radius in px, and whether it is drawn as a square. */
    readonly blip: { radius: number; square: boolean } | null;
}

/**
 * Minion scale is derived from the kind's own target height rather than
 * hardcoded per entry, so the two ranks stay in proportion if either height is
 * retuned.
 */
function minionScale(height: number): number {
    return GLTF_SCALE_MINION * (height / UNIT_HEIGHT_MINION);
}

const VISUALS: Record<number, UnitVisual> = {
    /**
     * The champion borrows the minion's golem model, scaled up to champion
     * height and tinted harder so the two never read as the same unit.
     *
     * This is a stand-in: `public/models/hero/` is the intended champion model
     * and it does not render under Murow at all: see the README's "The
     * champion model" section for the evidence. Point `modelId` back at
     * `'model-hero'` (and re-register the prefab in game-client.ts) the day
     * that rig works; nothing else here needs to change.
     */
    [KIND_CHAMPION]: {
        modelId: 'model-minion',
        scale: minionScale(UNIT_HEIGHT_CHAMPION),
        originY: 0,
        height: UNIT_HEIGHT_CHAMPION,
        tintKeep: 0.85,
        barSize: 'md',
        hitRadiusPx: 26,
        blip: { radius: 4.5, square: false },
    },
    [KIND_MINION]: {
        modelId: 'model-minion',
        scale: minionScale(UNIT_HEIGHT_MINION),
        originY: 0,
        height: UNIT_HEIGHT_MINION,
        tintKeep: 0.45,
        barSize: 'sm',
        hitRadiusPx: 16,
        blip: { radius: 1.8, square: false },
    },
    /**
     * The caster rank. Same model, there is only one minion rig, but shorter
     * and tinted much harder toward its team color, which is the only cue that
     * separates the two ranks at chase-camera distance. Two identically
     * coloured sizes read as "one of those is further away".
     */
    [KIND_MINION_CASTER]: {
        modelId: 'model-minion',
        scale: minionScale(UNIT_HEIGHT_MINION_CASTER),
        originY: 0,
        height: UNIT_HEIGHT_MINION_CASTER,
        tintKeep: 0.8,
        barSize: 'sm',
        hitRadiusPx: 14,
        blip: { radius: 1.8, square: false },
    },
    [KIND_TOWER]: {
        modelId: 'model-tower',
        scale: GLTF_SCALE_TOWER,
        rotation: GLTF_ROTATION_TOWER,
        originY: 0,
        height: UNIT_HEIGHT_TOWER,
        tintKeep: 0.75,
        barSize: 'md',
        hitRadiusPx: 30,
        blip: { radius: 4, square: true },
    },
    [KIND_BASE]: {
        modelId: 'unit',
        scale: NEXUS_CORE_SIZE,
        // Turned 45° so the core reads as a floating gem rather than a box.
        rotation: [0, Math.PI / 4, 0],
        originY: NEXUS_CORE_Y,
        height: UNIT_HEIGHT_BASE,
        tintKeep: 1,
        barSize: 'lg',
        hitRadiusPx: 42,
        blip: { radius: 6, square: true },
    },
};

export function visualFor(kind: number): UnitVisual {
    return VISUALS[kind] ?? VISUALS[KIND_CHAMPION];
}

/** Roughly mid-body height: for effects and hover tests that want "the middle". */
export function centerHeight(kind: number): number {
    return visualFor(kind).height / 2;
}

/** Where the HP bar floats: just clear of the model's head. */
export function barHeight(kind: number): number {
    return visualFor(kind).height + 0.35;
}

export function scaleTuple(kind: number): [number, number, number] {
    const scale = visualFor(kind).scale;
    return typeof scale === 'number' ? [scale, scale, scale] : [scale[0], scale[1], scale[2]];
}

/** Pulls `rgb` toward white, keeping `keep` of its distance from it. */
function tintTowardWhite(rgb: readonly [number, number, number], keep: number): [number, number, number] {
    return [
        1 - (1 - rgb[0]) * keep,
        1 - (1 - rgb[1]) * keep,
        1 - (1 - rgb[2]) * keep,
    ];
}

export function colorFor(team: number, kind: number): [number, number, number] {
    return tintTowardWhite(TEAM_COLOR[team] ?? NEUTRAL_COLOR, visualFor(kind).tintKeep);
}

/** `TEAM_COLOR` as a CSS `rgb()` string, for the DOM overlays. */
export function teamCssColor(team: number): string {
    const [r, g, b] = TEAM_COLOR[team] ?? NEUTRAL_COLOR;
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
