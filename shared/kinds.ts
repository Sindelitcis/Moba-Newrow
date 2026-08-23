/**
 * Entity kinds, stored as a numeric tag (`Components.Kind`) and networked so
 * the client can decide how to draw each unit.
 *
 * The predicates below exist because "is this a minion" stopped being a single
 * comparison the moment waves grew a second unit type: melee and caster
 * minions are two kinds that behave alike almost everywhere (targeting
 * priority, collision, the bot's notion of a frontline) and differ only in
 * their stats. Spelling that out as `kind === KIND_MINION || kind ===
 * KIND_MINION_CASTER` in a dozen places is exactly how one of them quietly
 * gets forgotten.
 */

export const KIND_CHAMPION = 0;
export const KIND_TOWER = 1;
export const KIND_BASE = 2;
/** Melee minion: the front rank of a wave. */
export const KIND_MINION = 3;
/** Caster minion: squishier, outranges the melee rank. */
export const KIND_MINION_CASTER = 4;

/** Every minion kind, in the order they line up in a wave (front to back). */
export const MINION_KINDS = [KIND_MINION, KIND_MINION_CASTER] as const;
/** Towers and bases: they hold ground, they never move, and they can be pushed. */
export const STRUCTURE_KINDS = [KIND_TOWER, KIND_BASE] as const;
/** Single-element list, for the kind filters that take one. */
export const CHAMPION_KINDS = [KIND_CHAMPION] as const;

export function isMinion(kind: number): boolean {
    return kind === KIND_MINION || kind === KIND_MINION_CASTER;
}

export function isStructure(kind: number): boolean {
    return kind === KIND_TOWER || kind === KIND_BASE;
}
