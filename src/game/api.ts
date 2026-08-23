/**
 * The surface `Game.tsx` talks to. Kept in its own module so the Newstack side
 * can `import type` it without dragging in anything from `murow/webgpu`: see
 * Game.tsx for why the two bundles stay separate.
 */

/**
 * `reconnecting` is distinct from `connecting` on purpose: the first is a cold
 * start, the second means the socket dropped mid-match and the client is
 * retrying on a backoff. `disconnected` only means "given up".
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface MatchResult {
    winner: number;
    killsA: number;
    killsB: number;
}

export interface ScoreState {
    killsA: number;
    killsB: number;
    selfKills: number;
    selfDeaths: number;
    /** Champions fielded per side, so the HUD can show 1v1 / 2v2 honestly. */
    sizeA: number;
    sizeB: number;
}

export const EMPTY_SCORE: ScoreState = {
    killsA: 0, killsB: 0, selfKills: 0, selfDeaths: 0, sizeA: 0, sizeB: 0,
};

/** The local champion's health, or `null` while it is dead or not yet assigned. */
export interface SelfState {
    team: number;
    current: number;
    max: number;
}

/**
 * A kill-feed entry, already resolved from the wire's numeric event code to
 * something the HUD can render. `team` is whoever the event is about.
 */
export interface FeedEntry {
    /** Monotonic id, so the HUD can key and expire entries without comparing text. */
    id: number;
    event: 'kill' | 'firstBlood' | 'towerDown' | 'nexusExposed';
    team: number;
}

export interface GameCallbacks {
    onStatus?(status: ConnectionStatus): void;
    /** The finished match's result, or `null` once the next one starts. */
    onMatchOver?(result: MatchResult | null): void;
    /** Seconds until the server rebuilds the arena, or `null` when no match has ended. */
    onNextMatchIn?(seconds: number | null): void;
    /** Whole seconds elapsed in the current match, straight from the server. */
    onClock?(seconds: number): void;
    onPing?(ms: number): void;
    /** Seconds left until the local champion respawns, or `null` when not waiting. */
    onRespawn?(secondsLeft: number | null): void;
    onScore?(score: ScoreState): void;
    /** The local champion's health, or `null` while dead. */
    onSelf?(self: SelfState | null): void;
    /**
     * Whether this player is watching rather than playing, because every seat
     * was taken when they arrived.
     *
     * Cleared by the server the moment one opens up, so the HUD only has to
     * render the state it is told about and never has to poll for a seat.
     */
    onSpectating?(spectating: boolean): void;
    onFeed?(entry: FeedEntry): void;
    /** 0 = ready, 1 = just used (drains back to 0 over the cooldown). */
    onAttackCooldown?(fraction: number): void;
    onCleaveCooldown?(fraction: number): void;
    onPotionCooldown?(fraction: number): void;
    onDashCooldown?(fraction: number): void;
    /**
     * Whether the local champion is standing inside an enemy tower's reach.
     *
     * Reported as a plain flag rather than "which tower", because the only
     * thing the HUD does with it is warn; the ring drawn on the ground already
     * says which one and which way is out.
     */
    onTowerDanger?(inRange: boolean): void;
    onMuted?(muted: boolean): void;
}

export interface GameOptions {
    /**
     * Champions per team to keep the arena topped up to with AI, or 0 for pure
     * PvP.
     *
     * The arena is shared, so this is a request rather than a match mode: bots
     * fill the seats nobody wants and give them straight back, so a human
     * arriving is never turned away by one. Re-sent on every reconnect, which
     * costs nothing because the request is a target rather than an increment.
     */
    botsPerTeam?: number;
}

export interface GameHandle {
    /** Concede the match; the server ends it and rebuilds the arena. */
    surrender(): void;
    dispose(): void;
}

/** The entry point `src/game-client.ts` publishes on `window`. */
export type InitGame = (
    canvas: HTMLCanvasElement,
    callbacks?: GameCallbacks,
    options?: GameOptions,
) => GameHandle;

/**
 * The game client is loaded with a plain `<script>` tag rather than imported
 * (see Game.tsx), so `window` is the only channel between the two bundles.
 * Declaring it here: in the one module both sides already share types
 * through: is what keeps `Game.tsx` from reaching for `(window as any)`.
 */
declare global {
    interface Window {
        __initMobaGame?: InitGame;
    }
}
