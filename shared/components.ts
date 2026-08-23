import { defineComponent, f32, u8, u16, u32 } from 'murow';
import { networked } from 'murow/netcode';

export namespace Components {
    /**
     * 2D world position on the XZ plane (Y is always 0: nothing jumps).
     * Synced every tick, interpolated linearly on the client.
     */
    export const Position = defineComponent('Position', {
        schema: { x: f32, z: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
    });

    /**
     * Team id (0 or 1) and entity kind (champion/tower/base/minion). Both are
     * set once at spawn and never change, so `on-change` is enough. Color is
     * derived client-side from (Team, Kind): no need to sync RGB.
     */
    export const Team = defineComponent('Team', {
        schema: { id: u8 },
        sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
    });

    export const Kind = defineComponent('Kind', {
        schema: { value: u8 },
        sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
    });

    /**
     * Current/max health. Changes only on hits, so `on-change` sync keeps
     * bandwidth down: handlers must mark it dirty explicitly when writing
     * (see server/damage.ts).
     */
    export const Health = defineComponent('Health', {
        schema: { current: u16, max: u16 },
        sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
    });

    /**
     * Whether a structure can currently be damaged at all, and why not.
     *
     * Networked because it is a rule the player has to be able to *see*: a
     * nexus that silently eats hits for no damage reads as a bug, where a
     * shielded one reads as "kill the towers first" (see
     * `NEXUS_REQUIRES_TOWERS_DOWN`). Only structures carry it.
     */
    export const Shield = defineComponent('Shield', {
        schema: { active: u8 },
        sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
    });

    /**
     * Server-only tick stamps: when each ability was last used, when the entity
     * was last hurt (which is what gates health regeneration), and when it last
     * attacked an enemy champion (which is what makes towers defend; see
     * `TOWER_CHAMPION_AGGRO_SEC`). Never synced: the client runs its own copy
     * of the cooldowns purely to drive the hotbar, and the server decides
     * whether an ability actually counts.
     *
     * `potionTick` does double duty: it is the potion's cooldown stamp *and*
     * the start of its heal-over-time window, because those are the same
     * instant and keeping them as one number means they cannot drift apart.
     *
     * The component also doubles as the "this entity can fight" marker: towers
     * and minions carry it, bases don't, so the systems that scan for attackers
     * can query on it (see server/systems.ts).
     */
    export const Timers = defineComponent('Timers', {
        attackTick: u32,
        cleaveTick: u32,
        potionTick: u32,
        dashTick: u32,
        damagedTick: u32,
        aggroTick: u32,
    });

    /**
     * Every timer field, at the value a freshly spawned or reset unit starts
     * with.
     *
     * Zero means "never happened", not "happened at tick 0": every reader
     * treats it as such, because at server start `tick` is also 0 and a naive
     * `tick - stamp < window` would fire every one of these windows at once.
     */
    export const ZERO_TIMERS = {
        attackTick: 0,
        cleaveTick: 0,
        potionTick: 0,
        dashTick: 0,
        damagedTick: 0,
        aggroTick: 0,
    };
}
