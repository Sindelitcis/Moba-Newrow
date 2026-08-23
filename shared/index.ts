/**
 * Barrel for everything shared between the game server, the game client and
 * the smoke test.
 *
 * Note that `src/Game.tsx` deliberately does *not* import from here: `arena`
 * and `predictions` pull in `murow` / `murow/netcode`, which would drag the
 * whole engine into Newstack's esbuild bundle and into its Node-run server
 * process. That file reaches straight into `../shared/constants` instead.
 */
export * from './math';
export * from './kinds';
export * from './constants';
export * from './teams';
export * from './movement';
export * from './components';
export * from './protocol';
export * from './predictions';
export * from './arena';
