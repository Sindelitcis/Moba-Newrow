import { worldToScreen } from './projection';

/**
 * Floating damage numbers for hits *you* landed.
 *
 * Deliberately not driven by watching health drop: the client can see any
 * entity lose health but not who caused it, so reacting to every drop lit the
 * screen up for two minions trading blows down the lane exactly as loudly as
 * for your own swing. These are spawned from the server's `hitLanded`, which
 * only the attacking peer receives.
 *
 * DOM rather than 3D for the same reason the health bars are: the renderer
 * has no billboarding and no text, and a number that always faces the camera
 * is a `<div>` with a transform.
 */
export interface HitMarkers {
    /** Shows `damage` rising from the world point `[x, z]`. */
    spawn(x: number, z: number, damage: number, lethal: boolean): void;
    /** Re-projects and ages every live marker. Call once per tick. */
    update(vp: Float32Array, width: number, height: number): void;
    clear(): void;
}

interface Marker {
    element: HTMLDivElement;
    x: number;
    z: number;
    bornAt: number;
}

const LIFETIME_MS = 850;
/** World height the number starts at and how far it drifts up over its life. */
const START_Y = 1.2;
const RISE = 1.1;

export function createHitMarkers(container: HTMLElement): HitMarkers {
    const markers: Marker[] = [];

    return {
        spawn(x, z, damage, lethal) {
            const element = document.createElement('div');
            element.className = lethal ? 'hit-marker lethal' : 'hit-marker';
            element.textContent = String(damage);
            container.appendChild(element);
            markers.push({ element, x, z, bornAt: performance.now() });
        },

        update(vp, width, height) {
            const now = performance.now();
            for (let i = markers.length - 1; i >= 0; i--) {
                const marker = markers[i];
                const age = (now - marker.bornAt) / LIFETIME_MS;
                if (age >= 1) {
                    marker.element.remove();
                    markers.splice(i, 1);
                    continue;
                }

                const screen = worldToScreen(vp, marker.x, START_Y + RISE * age, marker.z, width, height);
                if (screen === null) {
                    marker.element.style.display = 'none';
                    continue;
                }
                marker.element.style.display = '';
                marker.element.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -100%)`;
                // Hold full opacity for the first half, then fade out.
                marker.element.style.opacity = String(Math.min(1, 2 - age * 2));
            }
        },

        clear() {
            for (const marker of markers) marker.element.remove();
            markers.length = 0;
        },
    };
}
