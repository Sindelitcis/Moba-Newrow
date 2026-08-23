/**
 * Root for every DOM element drawn on top of the canvas (HP bars, the attack
 * range ring).
 *
 * Appended straight to `document.body` , NOT inside `.game-root` , because
 * Newstack does direct DOM diffing on every reactive property change (no
 * vdom), re-patching the subtree it rendered to match its JSX exactly. A node
 * manually injected inside that subtree gets wiped on the very next patch,
 * since it's not part of what `render()` produced. The `canvas` itself
 * survives patches fine (it's a real tracked `ref`), but arbitrary appended
 * children are not: same reason `Game.tsx`'s own `<script>` tag is appended
 * to `document.body` rather than inside the component tree.
 *
 * These overlays are chosen over 3D geometry on purpose: the renderer has no
 * billboarding and no way to change an instance's color after creation
 * (`addInstance` bakes color into a static GPU buffer), so "a changing
 * colored bar that always faces the camera" is far cheaper and simpler as a
 * DOM element positioned via manual world→screen projection.
 */
export interface Overlay {
    readonly root: HTMLDivElement;
    dispose(): void;
}

export function createOverlay(): Overlay {
    const root = document.createElement('div');
    root.className = 'game-overlay';
    document.body.appendChild(root);

    return {
        root,
        dispose() {
            root.remove();
        },
    };
}
