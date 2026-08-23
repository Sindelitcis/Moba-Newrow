import { GameLoop, type DriverType, World } from 'murow';
import { Components } from './components';
import { TICK_RATE } from './constants';

/**
 * Every component the world knows about, in one list.
 *
 * Murow's `World` only accepts components it was constructed with: adding one
 * to `components.ts` and forgetting it here fails at the first `world.add`,
 * loudly but not obviously. Declaring the set next to the world that registers
 * it keeps the two from drifting.
 */
const COMPONENTS = [
    Components.Position,
    Components.Team,
    Components.Kind,
    Components.Health,
    Components.Shield,
    Components.Timers,
];

/**
 * Per-process world + loop pair sharing the same component schema and tick rate
 * on both sides. `type` picks the loop driver (`'client'` for RAF-driven,
 * `'server-timeout'` for the fixed-step server).
 */
export class Arena<T extends DriverType = 'client'> {
    readonly world: World;
    readonly loop: GameLoop<T>;

    constructor(public readonly type: T, opts?: { maxEntities?: number }) {
        this.world = new World({
            maxEntities: opts?.maxEntities ?? 256,
            components: COMPONENTS,
        });
        this.loop = new GameLoop({ type, tickRate: TICK_RATE });
    }
}
