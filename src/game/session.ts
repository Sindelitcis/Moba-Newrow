import { Transports, type Entity, type PrefabBucket } from 'murow';
import { GameClient } from 'murow/netcode';
import type { WebGPU3DRenderer } from 'murow/webgpu';
import {
    ATTACK_RANGE,
    Arena,
    Components,
    FEED_CHAMPION_KILL,
    FEED_FIRST_BLOOD,
    FEED_NEXUS_EXPOSED,
    FEED_TOWER_DESTROYED,
    GAME_SERVER_PORT,
    KIND_TOWER,
    MATCH_RESET_SECONDS,
    RESPAWN_BASE_SECONDS,
    TEAM_A,
    TOWER_ATTACK_RANGE,
    WS_PATH,
    clamp,
    intents,
    predictions,
    rpcs,
} from '../../shared';
import type { FeedEntry, GameCallbacks, GameOptions, ScoreState } from './api';
import type { GameAudio } from './audio';
import { createControls } from './controls';
import { createEffects } from './effects';
import { createFacingTracker } from './facing';
import type { GroundRing, GroundRings } from './ground-rings';
import type { HitMarkers } from './hit-markers';
import type { HpBars } from './hp-bars';
import type { Minimap } from './minimap';
import { updateCamera } from './scene';
import { createWorldView } from './world-view';

/** Ping cadence, ms. Also the rate the interpolation delay is re-tuned at. */
const PING_INTERVAL_MS = 500;
/** Upper bound on the snapshot interpolation delay, ms. */
const MAX_INTERP_DELAY_MS = 600;
/** Height the hit spark appears at: roughly chest height on any unit. */
const HIT_SPARK_HEIGHT = 0.9;
/** How long after a match reset the arena rebuild's despawns stay silent. */
const REBUILD_AUDIO_MUTE_MS = 600;
/**
 * Radius of the marker drawn where a click-to-move order is headed. Kept under
 * `CHAMPION_RADIUS` so it reads as a point on the ground rather than as another
 * range circle competing with the attack ring around it.
 */
const MOVE_TARGET_RADIUS = 0.35;

/** Wire event code → the name the HUD renders. */
const FEED_EVENTS: Record<number, FeedEntry['event']> = {
    [FEED_CHAMPION_KILL]: 'kill',
    [FEED_FIRST_BLOOD]: 'firstBlood',
    [FEED_TOWER_DESTROYED]: 'towerDown',
    [FEED_NEXUS_EXPOSED]: 'nexusExposed',
};

export interface SessionDeps {
    canvas: HTMLCanvasElement;
    renderer: WebGPU3DRenderer;
    prefabs: PrefabBucket;
    bars: HpBars;
    hitMarkers: HitMarkers;
    rings: GroundRings;
    minimap: Minimap;
    audio: GameAudio;
    callbacks: GameCallbacks;
    options: GameOptions;
    /** Called when the transport closes, so the caller can retry. */
    onClosed(): void;
}

export interface Session {
    surrender(): void;
    dispose(): void;
}

/**
 * One connection's worth of game: its own `World`, `GameLoop` and
 * `GameClient`, plus every visual keyed to that world's entity ids.
 *
 * Making the session, rather than the whole client, the unit of teardown is
 * what makes reconnecting possible without touching Murow: `GameClient` binds
 * its transport in the constructor and `BrowserWs` opens its socket there, so
 * neither can be pointed at a fresh socket afterwards. Throwing the pair away
 * and building another is the only option, and doing that leaves entity ids
 * from two different worlds in play unless everything derived from them goes
 * with it. The renderer, prefabs, static scenery and audio outlive sessions
 * precisely because none of them are keyed by entity id.
 */
export function createSession(deps: SessionDeps): Session {
    const {
        canvas, renderer, prefabs, bars, hitMarkers, rings, minimap, audio, callbacks, options, onClosed,
    } = deps;

    const arena = new Arena('client');
    const minDelayMs = 3 * arena.loop.ticker.intervalMs;

    const transport = new Transports.BrowserWs(gameServerUrl());
    const client = new GameClient({
        world: arena.world,
        loop: arena.loop,
        transport,
        protocol: { intents, rpcs },
        strategy: {
            kind: 'snapshot-interpolation',
            delay: minDelayMs,
            staleWindow: MAX_INTERP_DELAY_MS * 2 + 100,
        },
    });
    client.use(predictions);

    let localEntity: Entity | null = null;
    let myTeam: number | null = null;
    let respawnRemaining: number | null = null;
    /**
     * How long the *next* death will cost, as last quoted by the server. The
     * wait scales with how often you have already died, so the client cannot
     * work it out, and the quote can arrive either side of the despawn that
     * starts the countdown, so it is stored rather than acted on directly.
     */
    let respawnQuote = RESPAWN_BASE_SECONDS;
    /** Non-null from the moment a match ends until the arena has been rebuilt. */
    let nextMatchIn: number | null = null;
    let feedCounter = 0;
    /** Last reported tower-danger state, so the HUD only hears about changes. */
    let inTowerRange = false;
    let disposed = false;
    /** Reused between frames; `updateRings` refills it every tick. */
    const ringBuffer: GroundRing[] = [];
    /**
     * Wall-clock deadline for ignoring structure-destroyed audio.
     *
     * A time window rather than an "is the match over" check, because the
     * ordering is against us: `matchReset` is an RPC, sent the moment the
     * server rebuilds, while the six despawns it causes only reach us in that
     * tick's *snapshot*, which lands afterwards. Keying off match state would
     * either let the rebuild play six explosions at once, or swallow the one
     * explosion that actually matters, the base falling.
     */
    let structureAudioMutedUntil = 0;

    const effects = createEffects(renderer, prefabs);
    const facing = createFacingTracker();
    const view = createWorldView({
        world: arena.world,
        renderer,
        prefabs,
        bars,
        effects,
        facing,
        onLocalDamaged: () => audio.hurt(),
        onStructureDestroyed: () => {
            if (performance.now() >= structureAudioMutedUntil) audio.structureDown();
        },
    });

    const controls = createControls({
        canvas,
        world: arena.world,
        view,
        effects,
        audio,
        intents: {
            move: (dx, dz) => client.sendIntent('move', { dx, dz }),
            attack: (aimX, aimZ) => client.sendIntent('attack', { aimX, aimZ }),
            cleave: () => client.sendIntent('cleave', {}),
            potion: () => client.sendIntent('potion', {}),
            dash: (dx, dz) => client.sendIntent('dash', { dx, dz }),
        },
        callbacks: {
            onAttackCooldown: (f) => callbacks.onAttackCooldown?.(f),
            onCleaveCooldown: (f) => callbacks.onCleaveCooldown?.(f),
            onPotionCooldown: (f) => callbacks.onPotionCooldown?.(f),
            onDashCooldown: (f) => callbacks.onDashCooldown?.(f),
            onMuted: (m) => callbacks.onMuted?.(m),
        },
    });

    // --- Netcode events ----------------------------------------------------

    client.on('spawn', ({ entity }) => view.onSpawn(entity));

    client.on('despawn', ({ entity }) => {
        view.onDespawn(entity);
        if (entity !== localEntity) return;
        localEntity = null;
        respawnRemaining = respawnQuote;
        callbacks.onRespawn?.(respawnRemaining);
        callbacks.onSelf?.(null);
        audio.death();
    });

    client.on('assigned', ({ entity }) => {
        localEntity = entity;
        myTeam = arena.world.has(entity, Components.Team)
            ? arena.world.get(entity, Components.Team).id
            : TEAM_A;
        respawnRemaining = null;
        respawnQuote = RESPAWN_BASE_SECONDS;
        callbacks.onRespawn?.(null);
    });

    client.on('connected', () => {
        callbacks.onStatus?.('connected');
        // Sent on connect rather than once seated, because it no longer depends
        // on which side we are on: the request tops up both teams. Sending it
        // unconditionally on every reconnect is safe precisely because it names
        // a size rather than asking for one more bot.
        const botsPerTeam = options.botsPerTeam ?? 0;
        if (botsPerTeam > 0) client.sendRpc('fillTeams', { perTeam: botsPerTeam });
    });
    // Guarded: `dispose()` closes the transport itself, and the resulting close
    // event lands a tick or two later: by which point a replacement session
    // may already exist. Reporting it would tear that one down too, and the
    // reconnect loop would never converge.
    client.on('disconnected', () => {
        if (!disposed) onClosed();
    });
    client.on('error', ({ error, context }) => console.error(`[client] ${context}:`, error));

    client.on('rpc', ({ name, payload }) => handleRpc(name, payload));

    function handleRpc(name: string, payload: unknown): void {
        switch (name) {
            case 'matchOver': {
                const result = payload as { winner: number; killsA: number; killsB: number };
                callbacks.onMatchOver?.(result);
                nextMatchIn = MATCH_RESET_SECONDS;
                callbacks.onNextMatchIn?.(nextMatchIn);
                if (myTeam !== null) audio.matchEnd(result.winner === myTeam);
                return;
            }
            case 'matchReset':
                // The server rebuilt the arena. Our champion was recycled as
                // part of that, so drop the victory screen and the death timer
                // the despawn started: this is a fresh match, not a respawn.
                callbacks.onMatchOver?.(null);
                nextMatchIn = null;
                callbacks.onNextMatchIn?.(null);
                respawnRemaining = null;
                respawnQuote = RESPAWN_BASE_SECONDS;
                callbacks.onRespawn?.(null);
                structureAudioMutedUntil = performance.now() + REBUILD_AUDIO_MUTE_MS;
                return;

            case 'clock':
                callbacks.onClock?.((payload as { seconds: number }).seconds);
                return;

            case 'score':
                callbacks.onScore?.(payload as ScoreState);
                return;

            case 'spectating':
                // Purely a report. Everything that makes the client a player
                // rather than a viewer already keys off `localEntity`, which
                // stays null for as long as no champion is assigned, so there
                // is no second code path to keep in step: the HUD just needs to
                // be able to say why.
                callbacks.onSpectating?.((payload as { active: number }).active === 1);
                return;

            case 'respawnIn': {
                respawnQuote = (payload as { seconds: number }).seconds;
                // The quote can land either side of the despawn that starts the
                // countdown. Arriving second, it has to correct a timer that is
                // already running off the previous estimate.
                if (respawnRemaining !== null) {
                    respawnRemaining = respawnQuote;
                    callbacks.onRespawn?.(respawnRemaining);
                }
                return;
            }

            case 'feed': {
                const { event, team } = payload as { event: number; team: number };
                const kind = FEED_EVENTS[event];
                if (kind !== undefined) callbacks.onFeed?.({ id: ++feedCounter, event: kind, team });
                return;
            }

            case 'cleaveFx': {
                const fx = payload as { x: number; z: number; team: number };
                effects.cleaveWave(fx.x, fx.z, fx.team);
                return;
            }

            case 'dashFx': {
                const fx = payload as {
                    fromX: number; fromZ: number; toX: number; toZ: number; team: number;
                };
                effects.dashTrail(fx.fromX, fx.fromZ, fx.toX, fx.toZ, fx.team);
                return;
            }

            case 'healFx': {
                // Broadcast, so this fires for the enemy's potion too, which is
                // the case that matters most: it is the cue to back off or
                // commit.
                const fx = payload as { x: number; z: number };
                effects.healBloom(fx.x, fx.z);
                return;
            }

            case 'hitLanded': {
                // Only this peer's own hits arrive here, which is exactly the
                // point: feedback for what *you* connected with, not for every
                // minion in the lane.
                const hit = payload as { x: number; z: number; damage: number; lethal: number };
                hitMarkers.spawn(hit.x, hit.z, hit.damage, hit.lethal === 1);
                effects.spark(hit.x, HIT_SPARK_HEIGHT, hit.z);
                audio.hit(hit.lethal === 1);
                return;
            }

            default:
                return;
        }
    }

    client.on('pong', ({ rtt }) => {
        // Track roughly half the round trip, floored at a few ticks so the
        // interpolation buffer always has something to interpolate between.
        client.setInterpolationDelay(
            clamp(rtt / 2 + arena.loop.ticker.intervalMs, minDelayMs, MAX_INTERP_DELAY_MS),
        );
        callbacks.onPing?.(Math.round(rtt));
    });

    // --- Per-frame work ----------------------------------------------------

    arena.loop.events.on('pre-tick', () => renderer.storePreviousState());

    // Guarded: an uncaught throw in here (e.g. the skinned-instance TypeGPU bug
    //: see vite-plugins/patch-murow-typegpu-metadata.ts) kills the *entire*
    // render loop silently, since nothing upstream catches exceptions thrown
    // from inside a requestAnimationFrame callback. One bad frame shouldn't
    // mean every frame after it is blank forever.
    arena.loop.events.on('render', ({ alpha }) => {
        try {
            renderer.render(alpha);
        } catch (e) {
            console.error('[game-client] render() threw:', e);
        }
    });

    arena.loop.every(PING_INTERVAL_MS).milliseconds(() => client.ping());

    arena.loop.events.on('tick', ({ deltaTime, input }) => {
        if (disposed) return;

        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const self = localEntity !== null && arena.world.has(localEntity, Components.Position)
            ? arena.world.get(localEntity, Components.Position)
            : null;
        const selfX = self?.x ?? 0;
        const selfZ = self?.z ?? 0;

        // Camera first: everything below projects through its matrix, and
        // click-to-move unprojects through it.
        updateCamera(renderer, myTeam ?? TEAM_A, selfX, selfZ);
        const viewProjection = renderer.camera.getViewProjectionMatrix();

        const state = {
            localEntity,
            myTeam,
            mouseX: controls.mouseX,
            mouseY: controls.mouseY,
            width,
            height,
            viewProjection,
        };
        view.sync(state);
        hitMarkers.update(viewProjection, width, height);
        controls.tick(input, deltaTime, state);
        effects.tick();
        minimap.update(view.units, myTeam, localEntity);
        reportSelf();

        updateRings(viewProjection, self !== null, selfX, selfZ, width, height);
        tickCountdowns(deltaTime);
    });

    /** Publishes the local champion's health, so the HUD can draw a status bar. */
    function reportSelf(): void {
        if (localEntity === null || myTeam === null || !arena.world.has(localEntity, Components.Health)) {
            return;
        }
        const health = arena.world.get(localEntity, Components.Health);
        callbacks.onSelf?.({ team: myTeam, current: health.current, max: health.max });
    }

    /**
     * Rebuilds the ground rings for this frame: your own attack range, the reach
     * of every enemy tower you are currently standing inside, and wherever a
     * click-to-move order is taking you.
     *
     * The tower rings are deliberately conditional. A permanent danger zone
     * around all four towers is wallpaper, you stop seeing it, whereas one
     * that appears the moment you cross the line *is* the warning, and then
     * shows you which way is out. Reported to the HUD as well, so the warning
     * survives the ring being off-screen behind you.
     */
    function updateRings(
        vp: Float32Array,
        alive: boolean,
        x: number,
        z: number,
        width: number,
        height: number,
    ): void {
        ringBuffer.length = 0;
        if (!alive) {
            rings.clear();
            reportTowerDanger(false);
            return;
        }

        for (const unit of view.units) {
            if (unit.kind !== KIND_TOWER || unit.team === myTeam) continue;
            if (Math.hypot(unit.x - x, unit.z - z) > TOWER_ATTACK_RANGE) continue;
            ringBuffer.push({ x: unit.x, z: unit.z, radius: TOWER_ATTACK_RANGE, style: 'tower-danger' });
        }
        reportTowerDanger(ringBuffer.length > 0);

        // A click order runs for seconds without further input, so without a
        // marker there is nothing on screen to distinguish "walking where I
        // asked" from "the click missed". It clears itself on arrival, which is
        // also how the player learns the order is finished.
        const destination = controls.destination;
        if (destination !== null) {
            ringBuffer.push({
                x: destination.x,
                z: destination.z,
                radius: MOVE_TARGET_RADIUS,
                style: 'move-target',
            });
        }

        const hovered = view.hoveredEnemy;
        const canHit = hovered !== null
            && !hovered.shielded
            && Math.hypot(hovered.x - x, hovered.z - z) <= ATTACK_RANGE;
        // Yours last, so it paints over the danger zones rather than under them.
        ringBuffer.push({
            x,
            z,
            radius: ATTACK_RANGE,
            style: canHit ? 'attack-ready' : 'attack',
        });

        rings.sync(vp, ringBuffer, width, height);
    }

    /** Edge-triggered, so the HUD isn't re-rendered twenty times a second. */
    function reportTowerDanger(inRange: boolean): void {
        if (inRange === inTowerRange) return;
        inTowerRange = inRange;
        callbacks.onTowerDanger?.(inRange);
    }

    function tickCountdowns(deltaTime: number): void {
        if (respawnRemaining !== null) {
            respawnRemaining = Math.max(0, respawnRemaining - deltaTime);
            callbacks.onRespawn?.(respawnRemaining);
        }
        if (nextMatchIn !== null) {
            nextMatchIn = Math.max(0, nextMatchIn - deltaTime);
            callbacks.onNextMatchIn?.(nextMatchIn);
        }
    }

    arena.loop.start();

    return {
        surrender() {
            if (!disposed) client.sendRpc('surrender', {});
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            arena.loop.stop();
            controls.dispose();
            view.dispose();
            hitMarkers.clear();
            effects.dispose();
            rings.clear();
            transport.close();
        },
    };
}

/**
 * The game server lives on its own port, separate from whichever server handed
 * out the page, so the URL is built from the page's host and that fixed port
 * rather than from `location` alone.
 */
function gameServerUrl(): string {
    const url = new URL(WS_PATH, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.hostname = location.hostname;
    url.port = String(GAME_SERVER_PORT);
    return url.toString();
}
