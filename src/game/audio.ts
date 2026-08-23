/**
 * Sound, synthesized on the fly with WebAudio oscillators: no audio assets
 * to license, host or load, and nothing to go stale if a model is swapped.
 *
 * Deliberately sparse: only events involving *your* champion make noise.
 * Playing a thud for every minion trading hits down the lane turns into
 * continuous static within one wave, which is worse than silence.
 *
 * Browsers refuse to start an AudioContext before a user gesture, so the
 * context is created lazily on the first click or keypress rather than at
 * init: calls that arrive before that are simply dropped.
 */
export interface GameAudio {
    /** Local champion swung its basic attack. */
    attack(): void;
    /** Local champion cast the cleave. */
    cleave(): void;
    /** Local champion drank a potion. */
    potion(): void;
    /** Local champion dashed. */
    dash(): void;
    /** A swing of yours connected. `lethal` when it was the killing blow. */
    hit(lethal: boolean): void;
    /** Local champion took damage. */
    hurt(): void;
    /** Local champion died. */
    death(): void;
    /** A tower or base was destroyed, either side. */
    structureDown(): void;
    matchEnd(won: boolean): void;
    /** Returns the new muted state. */
    toggleMuted(): boolean;
    dispose(): void;
}

interface ToneOptions {
    /** Starting frequency, Hz. */
    from: number;
    /** Frequency to glide to over the tone's length. Defaults to `from`. */
    to?: number;
    type?: OscillatorType;
    /** Seconds. */
    duration: number;
    /** Peak gain, 0..1. */
    gain?: number;
    /** Seconds to wait before starting. */
    delay?: number;
}

export function createAudio(): GameAudio {
    let ctx: AudioContext | null = null;
    let master: GainNode | null = null;
    let muted = false;
    let disposed = false;

    function ensureContext(): void {
        if (disposed || ctx !== null) return;
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor === undefined) return;
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = 0.35;
        master.connect(ctx.destination);
    }

    // A gesture is required before audio may start, and `resume()` is also
    // what recovers a context the browser suspended when the tab was hidden.
    const unlock = () => {
        ensureContext();
        void ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    function tone({ from, to, type = 'triangle', duration, gain = 0.5, delay = 0 }: ToneOptions): void {
        if (disposed || muted || ctx === null || master === null) return;
        if (ctx.state !== 'running') return;

        const start = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(from, start);
        if (to !== undefined && to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);

        // Fast attack, exponential decay: a plain gate would click audibly.
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(gain, start + 0.01);
        env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

        osc.connect(env);
        env.connect(master);
        osc.start(start);
        osc.stop(start + duration + 0.02);
    }

    return {
        attack() {
            tone({ from: 520, to: 300, type: 'square', duration: 0.09, gain: 0.28 });
        },
        cleave() {
            tone({ from: 180, to: 620, type: 'sawtooth', duration: 0.26, gain: 0.32 });
            tone({ from: 900, to: 400, type: 'triangle', duration: 0.2, gain: 0.2, delay: 0.05 });
        },
        potion() {
            // Rising, soft and consonant, so it never gets mistaken for the
            // percussive attack sounds: everything else in here falls in pitch.
            tone({ from: 380, to: 760, type: 'sine', duration: 0.3, gain: 0.24 });
            tone({ from: 570, to: 1140, type: 'sine', duration: 0.26, gain: 0.14, delay: 0.09 });
        },
        dash() {
            // Short upward sweep. Distinct from the potion's by being much
            // faster and starting far lower, so movement and healing never get
            // confused for one another mid-fight.
            tone({ from: 160, to: 900, type: 'sawtooth', duration: 0.14, gain: 0.2 });
        },
        hit(lethal) {
            // Crisper and higher than `hurt`, so landing one and taking one
            // never sound alike; a kill gets a short confirming ring on top.
            tone({ from: 900, to: 520, type: 'square', duration: 0.07, gain: 0.2 });
            if (lethal) tone({ from: 1200, to: 900, type: 'triangle', duration: 0.18, gain: 0.24, delay: 0.05 });
        },
        hurt() {
            tone({ from: 240, to: 120, type: 'square', duration: 0.12, gain: 0.22 });
        },
        death() {
            tone({ from: 300, to: 70, type: 'sawtooth', duration: 0.6, gain: 0.35 });
        },
        structureDown() {
            tone({ from: 140, to: 45, type: 'sawtooth', duration: 0.75, gain: 0.4 });
            tone({ from: 90, to: 40, type: 'square', duration: 0.5, gain: 0.3, delay: 0.08 });
        },
        matchEnd(won) {
            // Rising major triad for a win, falling minor one for a loss.
            const notes = won ? [523, 659, 784, 1047] : [523, 440, 349, 262];
            notes.forEach((freq, i) => {
                tone({ from: freq, type: 'triangle', duration: 0.35, gain: 0.3, delay: i * 0.16 });
            });
        },
        toggleMuted() {
            muted = !muted;
            return muted;
        },
        dispose() {
            disposed = true;
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
            void ctx?.close();
            ctx = null;
            master = null;
        },
    };
}
