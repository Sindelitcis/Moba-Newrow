import type { Entity } from 'murow';
import { clamp } from '../../shared';
import type { ScreenPoint } from './projection';
import { visualFor } from './unit-visuals';

/** Everything that can change about a bar between one tick and the next. */
export interface BarState {
    /** Where to draw it, or `null` to hide it (behind the camera). */
    screen: ScreenPoint | null;
    /** Health remaining, 0..1. */
    fraction: number;
    /** Structure that can't be damaged yet: drawn as a shield rather than health. */
    shielded: boolean;
}

/**
 * Floating health bars, one plain DOM element per entity, positioned by the
 * caller (see world-view.ts) from a manual world→screen projection.
 */
export interface HpBars {
    add(entity: Entity, team: number, kind: number): void;
    remove(entity: Entity): void;
    place(entity: Entity, state: BarState): void;
    /**
     * Rings the bar of the enemy the cursor is on, and only that one: the
     * counterpart to the range ring, and the other half of teaching the rule
     * that a swing needs a hovered target.
     */
    highlight(entity: Entity | null): void;
    /** Removes every bar: used when a session ends. */
    clear(): void;
}

interface Bar {
    root: HTMLDivElement;
    fill: HTMLDivElement;
    /** Last applied flags, so a tick that changes nothing touches no DOM. */
    shielded: boolean;
    hidden: boolean;
}

const HIGHLIGHT_CLASS = 'hovered';
const SHIELDED_CLASS = 'shielded';

export function createHpBars(container: HTMLElement): HpBars {
    const bars = new Map<Entity, Bar>();
    let highlighted: Entity | null = null;

    return {
        add(entity, team, kind) {
            const root = document.createElement('div');
            root.className = `hp-bar hp-bar-${visualFor(kind).barSize}`;
            const background = document.createElement('div');
            background.className = 'hp-bar-bg';
            const fill = document.createElement('div');
            fill.className = `hp-bar-fill team-${team}`;
            background.appendChild(fill);
            root.appendChild(background);
            container.appendChild(root);
            bars.set(entity, { root, fill, shielded: false, hidden: false });
        },

        remove(entity) {
            bars.get(entity)?.root.remove();
            bars.delete(entity);
            if (highlighted === entity) highlighted = null;
        },

        place(entity, { screen, fraction, shielded }) {
            const bar = bars.get(entity);
            if (bar === undefined) return;

            if (screen === null) {
                if (!bar.hidden) {
                    bar.root.style.display = 'none';
                    bar.hidden = true;
                }
                return;
            }
            if (bar.hidden) {
                bar.root.style.display = '';
                bar.hidden = false;
            }

            bar.root.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -100%)`;
            bar.fill.style.width = `${clamp(fraction, 0, 1) * 100}%`;

            if (bar.shielded !== shielded) {
                bar.shielded = shielded;
                bar.root.classList.toggle(SHIELDED_CLASS, shielded);
            }
        },

        highlight(entity) {
            if (highlighted === entity) return;
            if (highlighted !== null) bars.get(highlighted)?.root.classList.remove(HIGHLIGHT_CLASS);
            if (entity !== null) bars.get(entity)?.root.classList.add(HIGHLIGHT_CLASS);
            highlighted = entity;
        },

        clear() {
            for (const bar of bars.values()) bar.root.remove();
            bars.clear();
            highlighted = null;
        },
    };
}
