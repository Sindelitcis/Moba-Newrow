import type { Entity, World } from 'murow';
import {
    ATTACK_COOLDOWN_TICKS,
    ATTACK_RANGE,
    CLEAVE_COOLDOWN_TICKS,
    Components,
    DASH_COOLDOWN_TICKS,
    KIND_CHAMPION,
    POTION_COOLDOWN_TICKS,
    type Point2,
    TICK_RATE,
    forwardZ,
} from '../../shared';
import type { GameAudio } from './audio';
import type { Effects } from './effects';
import { createNavigator, type SteeringDirection } from './navigation';
import { screenToGround } from './projection';
import type { ViewState, WorldView } from './world-view';

const ATTACK_COOLDOWN_SECONDS = ATTACK_COOLDOWN_TICKS / TICK_RATE;
const CLEAVE_COOLDOWN_SECONDS = CLEAVE_COOLDOWN_TICKS / TICK_RATE;
const POTION_COOLDOWN_SECONDS = POTION_COOLDOWN_TICKS / TICK_RATE;
const DASH_COOLDOWN_SECONDS = DASH_COOLDOWN_TICKS / TICK_RATE;

/** Key bindings, in one place so the HUD's legend and the handler can't drift. */
const KEY_FORWARD = 'KeyW';
const KEY_BACK = 'KeyS';
const KEY_RIGHT = 'KeyD';
const KEY_LEFT = 'KeyA';
const KEY_ATTACK = 'Space';
const KEY_CLEAVE = 'KeyQ';
const KEY_POTION = 'KeyE';
const KEY_DASH = 'KeyF';
const KEY_MUTE = 'KeyM';

/** Every key that steers by hand, for the "did the player take over" test. */
const MOVEMENT_KEYS = [KEY_FORWARD, KEY_BACK, KEY_RIGHT, KEY_LEFT];

/** `MouseEvent.button` values. Left attacks, right sets a destination. */
const LEFT_BUTTON = 0;
const RIGHT_BUTTON = 2;

export interface ControlCallbacks {
    /** 0 = ready, 1 = just used (drains back to 0 over the cooldown). */
    onAttackCooldown(fraction: number): void;
    onCleaveCooldown(fraction: number): void;
    onPotionCooldown(fraction: number): void;
    onDashCooldown(fraction: number): void;
    onMuted(muted: boolean): void;
}

/**
 * The intents controls can send, one typed method each.
 *
 * Not a `send(name, payload)` dispatcher: that one was typed
 * `Record<string, number>` and cast to `never` at the call site, so when
 * `attack` grew an aim payload nothing complained that the client had stopped
 * sending one: the server silently fell back to "nearest enemy" and the
 * player's aim stopped mattering. One method per intent means the compiler
 * notices.
 */
export interface IntentSender {
    move(dx: number, dz: number): void;
    /** `[aimX, aimZ]` is where the player is pointing; the server picks what it hits. */
    attack(aimX: number, aimZ: number): void;
    cleave(): void;
    potion(): void;
    /** `[dx, dz]` is a direction; the server owns the distance. */
    dash(dx: number, dz: number): void;
}

export interface ControlDeps {
    canvas: HTMLCanvasElement;
    world: World;
    view: WorldView;
    effects: Effects;
    audio: GameAudio;
    intents: IntentSender;
    callbacks: ControlCallbacks;
}

/** The subset of Murow's per-tick input snapshot these controls read. */
export interface InputSnapshot {
    keys: Record<string, { down?: boolean } | undefined>;
}

/**
 * Turns the movement keys into a world direction, or null when none are held.
 *
 * WASD is team-relative: W is always "toward the enemy base" and D is always
 * "screen right". Both axes come from the same `forwardZ` the camera uses (see
 * scene.ts), which keeps the controls and the view agreeing for either spawn
 * side. With the camera behind the champion looking along `+sign * Z`,
 * screen-right is world `-sign * X` under a right-handed lookAt basis.
 */
function steeringDirection(
    down: (code: string) => boolean,
    myTeam: number | null,
): SteeringDirection | null {
    if (myTeam === null) return null;

    let forward = 0;
    let right = 0;
    if (down(KEY_FORWARD)) forward += 1;
    if (down(KEY_BACK)) forward -= 1;
    if (down(KEY_RIGHT)) right += 1;
    if (down(KEY_LEFT)) right -= 1;

    const magnitude = Math.hypot(forward, right);
    if (magnitude === 0) return null;

    const sign = forwardZ(myTeam);
    return {
        dx: (right / magnitude) * -sign,
        dz: (forward / magnitude) * sign,
    };
}

export interface Controls {
    /** Cursor position in canvas CSS px, or -1 when the cursor is off-canvas. */
    readonly mouseX: number;
    readonly mouseY: number;
    /** Where a click-to-move order is currently headed, or null. */
    readonly destination: Point2 | null;
    /** Runs one tick of movement, abilities and cooldown drain. */
    tick(input: InputSnapshot, deltaTime: number, state: ViewState): void;
    dispose(): void;
}

/**
 * Keyboard and mouse, plus the client-side mirror of each ability's cooldown.
 *
 * The cooldowns here exist only to drive the hotbar and to avoid spamming the
 * wire; the server keeps its own copy and is the one that decides whether a
 * swing counts (see server/combat.ts).
 *
 * Both movement schemes are always live and neither has to be switched on. What
 * they produce is the same `move` intent, once per tick: navigation.ts holds the
 * standing destination and decides which of the two the champion is obeying.
 */
export function createControls(deps: ControlDeps): Controls {
    const { canvas, world, view, effects, audio, intents, callbacks } = deps;

    const navigation = createNavigator();

    let mouseX = -1;
    let mouseY = -1;
    let attackCooldown = 0;
    let cleaveCooldown = 0;
    let potionCooldown = 0;
    let dashCooldown = 0;
    let localEntity: Entity | null = null;
    /** Key codes held as of last tick, for edge-triggered actions. */
    const heldLastTick = new Set<string>();

    /**
     * Left mouse button, the second binding for the basic attack.
     *
     * `held` drives the same repeat the attack key gets, so holding the button
     * swings on every cooldown. `pending` covers the gap that creates: held is
     * sampled once per tick, and a click shorter than the tick interval (50ms
     * at 20 Hz) is pressed and released between two samples, so without a latch
     * the fastest clicks are the ones that get dropped.
     */
    let leftButtonHeld = false;
    let leftButtonPending = false;

    /**
     * Where the right button was last pressed, in canvas CSS px, or -1 for none
     * outstanding.
     *
     * Latched like the left button's click, and for a stronger reason: a
     * destination is a single edge-triggered order, so a press and release that
     * both land between two tick samples has to survive until the next one or
     * the order is simply lost. The pixel is stored rather than the world point
     * because unprojecting needs the camera matrix, which only exists inside the
     * tick.
     */
    let rightClickX = -1;
    let rightClickY = -1;

    const onMouseMove = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
    };
    const onMouseLeave = () => {
        mouseX = -1;
        mouseY = -1;
    };
    const onMouseDown = (e: MouseEvent) => {
        // preventDefault so a press doesn't start a text or drag selection on
        // the page: the browser's selection UI flashing on every attack reads
        // as the game glitching.
        if (e.button === LEFT_BUTTON) {
            e.preventDefault();
            leftButtonHeld = true;
            leftButtonPending = true;
            return;
        }
        if (e.button !== RIGHT_BUTTON) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        rightClickX = e.clientX - rect.left;
        rightClickY = e.clientY - rect.top;
    };
    // On the window, not the canvas: a button released after the cursor has
    // left the canvas would otherwise never report the release, and the attack
    // would repeat forever.
    const onMouseUp = (e: MouseEvent) => {
        if (e.button === LEFT_BUTTON) leftButtonHeld = false;
    };
    // Right-clicking the world must not open the browser's own menu over it.
    // `mousedown` firing first is what lets the order through regardless.
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('mouseup', onMouseUp);

    /** Whether the left button asked for an attack this tick, consuming the latch. */
    function leftButtonWantsAttack(): boolean {
        const clicked = leftButtonPending;
        leftButtonPending = false;
        return leftButtonHeld || clicked;
    }

    /** Local champion's position, or null if it isn't in the world right now. */
    function localPosition(): { x: number; z: number } | null {
        if (localEntity === null || !world.has(localEntity, Components.Position)) return null;
        const pos = world.get(localEntity, Components.Position);
        // Copy out immediately: the caller reads other entities' positions,
        // which reuse this same object.
        return { x: pos.x, z: pos.z };
    }

    /**
     * Attacking requires the cursor to actually be over a *hittable* enemy
     * that's also within range, not just "nearest enemy in range" regardless
     * of aim. No hover, out of range, or a nexus still behind its towers: no
     * intent sent, no cooldown spent, no effect. Spending the swing on
     * something the server will refuse anyway is indistinguishable, from the
     * player's side, from the game dropping the input.
     */
    function tryAttack(): void {
        if (attackCooldown > 0) return;
        const self = localPosition();
        if (self === null) return;

        const target = view.hoveredEnemy;
        if (target === null || target.shielded || !world.isAlive(target.entity)) return;
        if (Math.hypot(target.x - self.x, target.z - self.z) > ATTACK_RANGE) return;

        attackCooldown = ATTACK_COOLDOWN_SECONDS;
        callbacks.onAttackCooldown(1);
        // The aim point travels with the intent, so the server hits what the
        // player was pointing at rather than whatever is nearest to them.
        intents.attack(target.x, target.z);

        const handle = localEntity === null ? undefined : view.handleOf(localEntity);
        if (handle !== undefined) effects.pulse(handle, KIND_CHAMPION);
        effects.bolt(self.x, self.z, target.x, target.z);
        audio.attack();
    }

    /** The cleave needs no target at all: it hits whatever happens to be close. */
    function tryCleave(): void {
        if (cleaveCooldown > 0) return;
        if (localPosition() === null) return;

        cleaveCooldown = CLEAVE_COOLDOWN_SECONDS;
        callbacks.onCleaveCooldown(1);
        intents.cleave();
        // The wave itself is drawn when the server echoes `cleaveFx` back, so
        // every player sees the same thing: including this one.
        audio.cleave();
    }

    /**
     * Drinks, if there is any point.
     *
     * Refused at full health on the client as well as the server, so a reflex
     * press while topped up doesn't spend a 30-second cooldown. The server
     * refuses it too (`resolvePotion`); this half only exists so the hotbar
     * doesn't start counting down for something that never happened.
     */
    function tryPotion(): void {
        if (potionCooldown > 0) return;
        if (localEntity === null || !world.has(localEntity, Components.Health)) return;

        const health = world.get(localEntity, Components.Health);
        if (health.current >= health.max || health.current <= 0) return;

        potionCooldown = POTION_COOLDOWN_SECONDS;
        callbacks.onPotionCooldown(1);
        intents.potion();
        audio.potion();
    }

    /**
     * Displaces in whichever direction the champion is already heading, or
     * toward the enemy base when it is standing still.
     *
     * `heading` is whatever won this tick's arbitration, so a dash follows the
     * keys when they are held and follows the path when a click order is
     * running. Dashing along the current leg is what "where I am going" means
     * under either scheme, and it keeps the ability from lurching off toward
     * the enemy base the moment the player stops touching the keyboard.
     */
    function tryDash(heading: SteeringDirection | null, myTeam: number | null): void {
        if (dashCooldown > 0 || localEntity === null || myTeam === null) return;

        const { dx, dz } = heading ?? { dx: 0, dz: forwardZ(myTeam) };
        dashCooldown = DASH_COOLDOWN_SECONDS;
        callbacks.onDashCooldown(1);
        intents.dash(dx, dz);
        audio.dash();
    }

    function drain(remaining: number, total: number, deltaTime: number, report: (f: number) => void): number {
        if (remaining <= 0) return 0;
        const next = Math.max(0, remaining - deltaTime);
        report(next / total);
        return next;
    }

    /**
     * Turns an outstanding right click into a destination, consuming the latch.
     *
     * The click is dropped rather than queued when it cannot be turned into a
     * ground point: no champion to move, or a pixel whose ray never meets the
     * ground, which is what clicking the sky means.
     */
    function takeRightClick(state: ViewState): void {
        const screenX = rightClickX;
        const screenY = rightClickY;
        rightClickX = -1;
        rightClickY = -1;
        if (screenX < 0) return;

        const self = localPosition();
        if (self === null) return;

        const target = screenToGround(state.viewProjection, screenX, screenY, state.width, state.height);
        if (target === null) return;
        navigation.order(self.x, self.z, target.x, target.z);
    }

    return {
        get mouseX() { return mouseX; },
        get mouseY() { return mouseY; },
        get destination() { return navigation.destination; },

        tick(input, deltaTime, state) {
            localEntity = state.localEntity;

            attackCooldown = drain(attackCooldown, ATTACK_COOLDOWN_SECONDS, deltaTime, callbacks.onAttackCooldown);
            cleaveCooldown = drain(cleaveCooldown, CLEAVE_COOLDOWN_SECONDS, deltaTime, callbacks.onCleaveCooldown);
            potionCooldown = drain(potionCooldown, POTION_COOLDOWN_SECONDS, deltaTime, callbacks.onPotionCooldown);
            dashCooldown = drain(dashCooldown, DASH_COOLDOWN_SECONDS, deltaTime, callbacks.onDashCooldown);

            const down = (code: string) => input.keys[code]?.down === true;
            const pressed = (code: string) => {
                if (!down(code)) {
                    heldLastTick.delete(code);
                    return false;
                }
                if (heldLastTick.has(code)) return false;
                heldLastTick.add(code);
                return true;
            };

            if (pressed(KEY_MUTE)) callbacks.onMuted(audio.toggleMuted());

            // Structures are the only things worth routing around: minions and
            // champions move, and the server's push-apart already handles
            // walking into one.
            navigation.syncBlockers(view.units);
            takeRightClick(state);

            const self = localPosition();
            if (self === null) navigation.cancel();

            const manual = {
                active: MOVEMENT_KEYS.some(down),
                direction: steeringDirection(down, state.myTeam),
            };
            const heading = self === null
                ? manual.direction
                : navigation.steer(self.x, self.z, deltaTime, manual);
            if (heading !== null) intents.move(heading.dx, heading.dz);

            // Held, not edge-triggered: holding either binding auto-swings on
            // every cooldown, which is what players expect from a basic attack.
            // `leftButtonWantsAttack` is called unconditionally so its latch is
            // consumed on the tick it was set, whether or not the key is also
            // down.
            const clickedAttack = leftButtonWantsAttack();
            if (down(KEY_ATTACK) || clickedAttack) tryAttack();
            if (down(KEY_CLEAVE)) tryCleave();
            // Edge-triggered, unlike the two above. On cooldowns this long a
            // held key would fire the instant it came back up, which is never
            // what holding it was meant to express.
            if (pressed(KEY_POTION)) tryPotion();
            if (pressed(KEY_DASH)) tryDash(heading, state.myTeam);
        },

        dispose() {
            canvas.removeEventListener('mousemove', onMouseMove);
            canvas.removeEventListener('mouseleave', onMouseLeave);
            canvas.removeEventListener('mousedown', onMouseDown);
            canvas.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('mouseup', onMouseUp);
        },
    };
}
