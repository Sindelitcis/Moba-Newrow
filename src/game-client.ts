import { PrefabBucket } from 'murow';
import { WebGPU3DRenderer } from 'murow/webgpu';
import type { GameCallbacks, GameHandle, GameOptions, InitGame } from './game/api';
import { createAudio } from './game/audio';
import { createGroundRings } from './game/ground-rings';
import { createHitMarkers } from './game/hit-markers';
import { createHpBars } from './game/hp-bars';
import { createMinimap } from './game/minimap';
import { createOverlay } from './game/overlay';
import { buildArena, configureScene } from './game/scene';
import { createSession, type Session } from './game/session';

export type {
    ConnectionStatus,
    FeedEntry,
    GameCallbacks,
    GameHandle,
    GameOptions,
    MatchResult,
    ScoreState,
    SelfState,
} from './game/api';

/**
 * Reconnection backoff. Doubles from the first delay up to the cap, and resets
 * as soon as a connection succeeds. The first retry is deliberately quick: the
 * overwhelmingly common case is the game server being restarted in the next
 * terminal over, and a 3-second stare at "reconnecting" for what is really a
 * one-second outage feels much worse than it is.
 */
const RECONNECT_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

/**
 * Instance budget. Roughly: ~38 static scenery + 2 bases × 7 (core + nexus) + 4
 * towers + up to 6 champions + several minion waves in flight + a handful of
 * transient VFX cubes. 384 leaves headroom for a lane that stalls and lets
 * minions pile up.
 */
const MAX_INSTANCES = 384;

export const initGame: InitGame = (
    canvas: HTMLCanvasElement,
    callbacks: GameCallbacks = {},
    options: GameOptions = {},
): GameHandle => {
    let disposed = false;
    let session: Session | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = RECONNECT_DELAY_MS;
    let hasConnected = false;
    let idleFrame: number | null = null;

    const prefabs = new PrefabBucket('3d')
        // No `grid` prefab any more: the arena floor is built out of scaled
        // `unit` cubes instead (see buildArena), because the wireframe grid read
        // as a floating blueprint rather than as ground.
        .add({ type: 'cube', id: 'unit', size: 1 })
        // The tower's own clips are never used, so they're skipped at parse time
        // (`animations: []` = "load zero clips"). The minion keeps its clip -
        // note that `addSkinnedInstance` auto-creates a playing state for any
        // model that has clips, so it animates from spawn even without an
        // explicit `play()`.
        //
        // `models/hero/` is deliberately NOT registered: that rig does not
        // render under Murow at all (see README, "The champion model"). Adding
        // it back costs nothing but also shows nothing.
        .add({ type: 'gltf', id: 'model-tower', src: '/models/tower/scene.gltf', animations: [] })
        .add({ type: 'gltf', id: 'model-minion', src: '/models/minion/scene.gltf' });

    const overlay = createOverlay();
    const bars = createHpBars(overlay.root);
    const hitMarkers = createHitMarkers(overlay.root);
    const rings = createGroundRings(overlay.root);
    const minimap = createMinimap(overlay.root);
    const audio = createAudio();

    /**
     * Keeps the static scene on screen while no session's loop is running -
     * i.e. during the reconnect backoff. Without it the canvas holds whatever
     * frame it was on when the socket dropped, units and all, which reads as
     * the game having frozen rather than as it waiting.
     */
    function startIdlePump(renderer: WebGPU3DRenderer): void {
        if (idleFrame !== null || disposed) return;
        const frame = () => {
            idleFrame = requestAnimationFrame(frame);
            if (session !== null) return;
            try {
                renderer.storePreviousState();
                renderer.render(1);
            } catch (e) {
                console.error('[game-client] idle render() threw:', e);
            }
        };
        idleFrame = requestAnimationFrame(frame);
    }

    function stopIdlePump(): void {
        if (idleFrame === null) return;
        cancelAnimationFrame(idleFrame);
        idleFrame = null;
    }

    /** A first attempt is "connecting"; anything after a successful one is a retry. */
    function pendingStatus(): 'connecting' | 'reconnecting' {
        return hasConnected ? 'reconnecting' : 'connecting';
    }

    function connect(renderer: WebGPU3DRenderer): void {
        if (disposed) return;
        stopIdlePump();
        callbacks.onStatus?.(pendingStatus());

        session = createSession({
            canvas,
            renderer,
            prefabs,
            bars,
            hitMarkers,
            rings,
            minimap,
            audio,
            options,
            callbacks: {
                ...callbacks,
                onStatus: (status) => {
                    if (status === 'connected') {
                        hasConnected = true;
                        reconnectDelay = RECONNECT_DELAY_MS;
                    }
                    callbacks.onStatus?.(status);
                },
            },
            onClosed: () => scheduleReconnect(renderer),
        });
    }

    function scheduleReconnect(renderer: WebGPU3DRenderer): void {
        if (disposed || reconnectTimer !== null) return;

        // Deferred out of the transport's own close handler: tearing the session
        // down calls `loop.stop()` and frees renderer slots, and doing that from
        // inside an event the session is still emitting is asking for a
        // half-disposed object to be touched again. The timer stays non-null
        // across both phases, so a second close (the error and the close both
        // fire on a refused connection) can't queue a duplicate retry.
        reconnectTimer = setTimeout(() => {
            session?.dispose();
            session = null;
            if (disposed) {
                reconnectTimer = null;
                return;
            }

            callbacks.onStatus?.(pendingStatus());
            startIdlePump(renderer);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect(renderer);
            }, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
        }, 0);
    }

    void (async () => {
        // PrefabBucket must finish loading before WebGPU3DRenderer is
        // constructed: its constructor reads bucket stats synchronously.
        await prefabs.load();
        const renderer = new WebGPU3DRenderer(canvas, {
            clearColor: [0.05, 0.07, 0.13, 1],
            autoResize: true,
            prefabs,
            maxInstances: MAX_INSTANCES,
        });
        await renderer.init();
        if (disposed) return;

        configureScene(renderer);
        buildArena(renderer, prefabs);

        // Only connect once the renderer exists. WebGPU init is async (GPU
        // adapter/device + shader compile) and used to lose the race against the
        // first snapshot arriving, and `Network`'s emit has no replay, so a
        // `spawn` with no listener attached yet was simply dropped. Connecting
        // afterwards removes the race instead of buffering around it.
        connect(renderer);
    })().catch((e) => console.error('[game-client] init failed', e));

    return {
        surrender() {
            session?.surrender();
        },

        dispose() {
            disposed = true;
            if (reconnectTimer !== null) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            stopIdlePump();
            session?.dispose();
            session = null;
            minimap.dispose();
            audio.dispose();
            overlay.dispose();
        },
    };
};

// Built as a standalone bundle by vite.config.ts and loaded via a plain
// <script> tag from Game.tsx's hydrate() (see that file for why): expose the
// entry point as a global instead of an ES export. The `Window` augmentation
// that types it lives in game/api.ts, which both bundles share.
window.__initMobaGame = initGame;
