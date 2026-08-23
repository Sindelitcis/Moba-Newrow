# moba-3x3

A 3v3 MOBA prototype. Two teams, two nexuses, two towers per team, minion waves
along a single lane. Server-authoritative multiplayer.

Built on two libraries consumed from local sibling repositories, not npm:

| Library | Role | Source |
| --- | --- | --- |
| [Murow](https://github.com/moureau-dev/murow) | ECS, fixed-step loop, netcode, WebGPU renderer | `file:../murow/packages/murow` |
| [Newstack](https://github.com/moureau-dev/newstack) | Page shell, HUD, SSR, router | `file:../newstack/.../moureau-newstack-0.0.77.tgz` |

Neither sibling repository is modified by this project. Where a fix belongs
upstream, it is applied here instead, as an in-memory build-time transform (see
[Build pipeline](#build-pipeline)).

## Requirements

- Bun 1.3+ (runs the game server and the scripts)
- Node 22+ (Newstack's CLI spawns its own server under Node)
- A WebGPU-capable browser
- `../murow` and `../newstack` present and built

## Running

```bash
bun install
bun run build
```

Two processes, in separate terminals:

```bash
bun run game-server   # authoritative simulation, ws://localhost:3010/ws
bun run start         # Newstack page, http://localhost:3000
```

`src/game-client.ts` and `src/game/` are built by a separate bundler. After
changing either, re-run `bun run build:game-client` or keep
`bun run dev:game-client` watching. Without it the browser keeps serving the
previous bundle.

| Script | Purpose |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit`, strict, whole project |
| `bun run rules` | Game rules against a real `Arena`, no sockets |
| `bun run smoke` | End-to-end against a running game server |
| `bun run capture` | Frame sink on :3011 for the render harness |
| `bun run probe` | Headless lane measurement, for balance work |

## Architecture

Two processes that do not share a runtime.

```
browser tab
  |
  |-- HTTP  --> server.ts        Newstack SSR, port 3000, Node
  |               renders src/Application.tsx -> src/Game.tsx (HUD)
  |               serves public/game-client.js as a static asset
  |
  '-- WS    --> game-server.ts   Murow GameServer, port 3010, Bun
                  ECS world, 20 Hz tick, intents, snapshots, RPCs
```

The split is forced, not stylistic. Newstack's CLI always spawns its server
under plain Node, while Murow's netcode build relies on Bun's more lenient ESM
resolution. The page and the simulation therefore run as separate processes on
separate ports, and the browser opens a WebSocket directly to the game server
regardless of which port served the page.

### How Murow is used

| Murow API | Used for |
| --- | --- |
| `World`, `defineComponent` | Entity state, declared in `shared/components.ts` |
| `GameLoop` | Fixed 20 Hz tick, `server-timeout` driver on the server, `client` (rAF) driver in the browser |
| `defineIntents` / `defineHandlers` | Client to server commands and their server-side resolution |
| `defineRpcs` | Server to client events, plus two client to server requests |
| `definePredictions` | Movement replayed identically on both sides |
| `NavMesh` | Client-side routing for click-to-move, in `graph` mode |
| `Transports.BunWsServer` / `BrowserWs` | WebSocket transport |
| `WebGPU3DRenderer`, `PrefabBucket` | Rendering, cube and GLTF instances |

Design constraints Murow imposes, and the resulting decisions:

- **`world.get()` returns one object per component type, reused across calls.**
  Holding two results of the same component at once silently aliases them. Every
  read in this codebase copies to plain numbers immediately. `server/collision.ts`
  snapshots the whole world into typed arrays first for the same reason.
- **`world.query()` returns a cached buffer that `despawn` mutates.** Any pass
  that can kill something iterates a copied array.
- **Entity ids are recycled immediately.** `peer.entity` is never cleared on
  despawn, so `server/roster.ts` tracks the live champion in `Player.entity`
  instead, where `null` can mean "dead, awaiting respawn". The match reset
  recycles living champions in place rather than despawning and respawning them,
  because a same-tick respawn returns the same id and the client cannot tell the
  two apart.
- **`GameClient` binds its transport in the constructor**, and `BrowserWs` opens
  its socket in its own. Neither can be repointed, so reconnecting rebuilds the
  whole session (`src/game/session.ts`). Everything keyed by entity id is
  rebuilt with it; the renderer, prefabs, scenery and audio outlive sessions
  because none of them are.
- **The client loop is rAF-driven.** A tab that is not compositing never ticks.
  `public/harness.html` swaps in a `setTimeout` shim for headless inspection.
- **The GLTF parser does not walk a mesh node's ancestors.** Sketchfab exports
  put scale and axis correction on a parent node, which is therefore dropped.
  `scripts/measure-gltf-scale.py` reproduces the parser's view to derive
  `GLTF_SCALE_*`, and the tower's axis correction is reapplied per instance via
  `GLTF_ROTATION_TOWER`.
- **`Camera3D` exposes no projection helper, in either direction.**
  `src/game/projection.ts` does the clip-space transform by hand for the DOM
  overlays, and inverts the same matrix for click-to-move. The inverse runs in
  double precision: at f32 it is accurate enough to place a health bar and
  visibly wrong at the far end of the lane.
- **`NavMesh` in `graph` mode returns its two arguments unchanged** when nothing
  blocks the ray between them, and a grid path when something does. That makes
  it a line-of-sight test as well as a pathfinder, which is what
  `src/game/navigation.ts` string-pulls the grid staircase straight with. Its
  grid search is otherwise unbounded, so the walkable area is fenced in with
  four wall obstacles: without them an unreachable goal expands cells forever.
- **`addInstance` bakes colour into a static buffer** and the renderer has no
  billboarding or text. Health bars, damage numbers, ground rings and the
  minimap are therefore DOM and SVG positioned by manual projection, not
  geometry.

### How Newstack is used

`src/Application.tsx` mounts `src/Game.tsx` at `/`. `Game.tsx` is a single
class component holding the canvas ref and all HUD state.

Framework conventions this project follows:

- Class components only; state is plain instance properties, and assigning to
  one triggers a re-render.
- Reactivity is shallow. Arrays are reassigned rather than mutated in place.
- `class`, not `className`. `style` takes a string.
- Lowercase DOM events (`onclick`, `onmouseleave`).
- Methods take exactly one argument, an object. The component proxy merges the
  live context into whatever object a method is called with, so `start()`
  declares only `{ botsPerTeam }`, the part the caller supplies.
- `prepare()` runs on server and client; `hydrate()` is client-only.

Two workarounds are load-bearing:

- **`hydrate()` has been observed firing twice, synchronously, for one mount.**
  A module-level `hydrated` flag guards it, set before any async work. An
  instance property would not work, because it is only assigned once the script
  `onload` fires.
- **Newstack diffs the DOM directly against its JSX.** Nodes injected into that
  subtree are wiped on the next patch. The world overlay is therefore appended
  to `document.body`, outside the component tree, and the game client `<script>`
  tag likewise.

Newstack ships no `JSX` namespace, which makes every element an implicit `any`
under `strict`. `src/@types/newstack-jsx.d.ts` declares a permissive one so the
project can keep strict mode.

## Build pipeline

Two bundlers, deliberately, with no shared module graph.

```
src/Application.tsx, src/Game.tsx   --esbuild (Newstack CLI)--> dist/
src/game-client.ts, src/game/*      --Vite + Rollup------------> public/game-client.js
```

`Game.tsx` loads the second bundle with a plain `<script>` tag and reads it off
`window.__initMobaGame`. It imports only types from `src/game/api.ts`, which are
erased at build time.

The separation exists because `WebGPU3DRenderer`'s shaders are authored with
`tgpu.fn`. Bundling them twice, once inside Murow's published dist and once
through Newstack's pipeline, produces identifier collisions that break TypeGPU's
runtime shader-metadata resolution. `Game.tsx` therefore imports its constants
from `shared/constants.ts` and `shared/teams.ts` directly rather than through
the `shared` barrel, which re-exports modules that pull in Murow.

`vite.config.ts` also:

- aliases `murow/*` to the sibling repo's TypeScript source and force-dedupes
  `typegpu`, because Murow's own `node_modules` contains a second copy and two
  `tgpu` singletons break TypeGPU's metadata `WeakMap`;
- disables minification, because Murow's runtime name-recovery cannot reverse
  minified external names.

`vite-plugins/patch-murow-typegpu-metadata.ts` rewrites one Murow source file in
memory at build time. It fixes three defects, and throws if the snippets it
anchors on ever change upstream:

1. Bundler-renamed identifiers (`vec3f$1`) were only recovered for esbuild's
   naming convention, not Rollup's, and were never resolved at all when a
   hardcoded `knownExternalNames` list was supplied.
2. An eager `getExternals()` call threw for `ComputeBuilder`, which made every
   skeletal-animation kernel fail to build. Any skinned GLTF instance then threw
   inside `render()` before a single draw call, blanking the canvas.
3. `splitDecls` forced every declaration to `const`, so any TGSL source
   reassigning a local failed resolution. The animation kernel does this
   throughout.

## Layout

`shared/` is everything both processes must agree on. It has no dependency on
`server/` or `src/`.

| Module | Contents |
| --- | --- |
| `kinds.ts` | Entity kinds, `isMinion`, `isStructure` |
| `teams.ts` | Team ids, `forwardZ`, `baseZ`, `enemyOf` |
| `constants.ts` | Tuned numbers, including the per-kind minion stat table |
| `components.ts`, `arena.ts` | Component schema, and the world plus loop pair that registers it |
| `protocol.ts` | Intents, RPCs, and the `Intents`/`Rpcs` schema types |
| `movement.ts`, `predictions.ts` | Lane clamp, one movement step, direction normalisation |
| `math.ts` | `clamp` |

`server/` is the rules. `game-server.ts` is a composition root and contains no
logic of its own.

| Module | Contents |
| --- | --- |
| `host.ts` | Seats, champions, respawns, bots, score, kill feed, match cycle |
| `match.ts` | The single over/not-over flag and the match clock |
| `roster.ts`, `scoreboard.ts` | Spawn-slot free list; per-team and per-player tallies |
| `spawn.ts` | Structures, champions, minion waves |
| `damage.ts` | Damage application and the consequences of death |
| `abilities.ts` | What each ability does, shared by players and bots |
| `combat.ts` | Intent handlers |
| `targeting.ts` | Legal target selection |
| `systems.ts` | Tick-driven minions, towers, nexus shields, regeneration |
| `collision.ts`, `bot.ts` | Circle separation; the lane bot |

`src/game/` is the client. `src/game-client.ts` loads prefabs, brings up the
renderer, builds the static scene and owns the reconnect loop.

| Module | Contents |
| --- | --- |
| `session.ts` | One connection: `Arena`, `GameClient`, transport, per-tick orchestration |
| `world-view.ts` | Networked entities to renderer instances, and the per-tick unit snapshot everything else reads |
| `controls.ts` | Input, client-side cooldown mirrors, intent dispatch |
| `navigation.ts` | The standing click-to-move destination, its path, and which input scheme wins |
| `scene.ts`, `nexus.ts`, `unit-visuals.ts` | Static geometry, the cube-built nexus, the per-kind visual table |
| `effects.ts`, `facing.ts`, `audio.ts` | Transient VFX, model heading, synthesized audio |
| `overlay.ts`, `hp-bars.ts`, `hit-markers.ts`, `ground-rings.ts`, `minimap.ts` | DOM and SVG layer over the canvas |
| `projection.ts` | World to screen for those overlays, and screen to ground for click-to-move |
| `api.ts` | The types `Game.tsx` imports, plus the `window` declaration |

## Game rules

### Movement

Two input schemes drive one champion, and they differ in kind. WASD is
stateless: a direction every tick while keys are held, nothing at all once they
come up. Click-to-move is stateful: one right click, then seconds of walking
with no further input.

**The destination lives on the client only.** Not a networked component, and not
something the server recomputes. The alternative has both sides deriving a
direction from a path, and `definePredictions` replays the same movement
function on both, so any disagreement about that path is a disagreement about
the champion's position: an obstacle set that differs for one tick, a float that
rounds the other way, a tower that fell on the server first. Reconciliation then
corrects by snapping, and the movement visibly trembles. The path is the fragile
part, so it is computed on one machine.

What crosses the wire is therefore unchanged: one `move` intent per tick
carrying a direction, exactly what a held key already produces. The server
cannot tell an order from a key press, the prediction stays the pure function of
(state, payload, deltaTime) it has to be, and the bot goes on steering through
`stepChampion` untouched. Trusting the direction grants nothing new, for the
same reason the dash gives for accepting one: a player can already walk in any
direction, so naming one is not new authority.

The two are arbitrated in one place, `src/game/navigation.ts`, once per tick:

- **A held movement key wins outright and drops the standing order.** Keyed off
  the keys rather than the direction they produce, because W and S together are
  two keys held that add up to nothing, and that is still the player steering.
  Leaving both live is the one way these can genuinely fight.
- **Arriving stops the champion and clears the order.** The last leg stops a
  whole step short rather than overshooting and stepping back: `stepChampion`
  always travels a full tick's worth, so an exact arrival is a champion
  vibrating on the spot.
- **Orders that land somewhere unstandable are moved, not refused.** Outside the
  lane they are clamped in; on top of a structure they are pushed to its rim. An
  order that silently does nothing is indistinguishable from a dropped click.

Routing is Murow's `NavMesh`, and only structures are obstacles. Minions and
champions move, and `resolveCollisions` already pushes units apart; re-planning
around a wave every tick would be both expensive and stale by the time it
finished. Obstacles are inflated by `CHAMPION_RADIUS`, because the navmesh
routes a point and the champion is a body: a path that grazes a tower is a path
that walks a shoulder through it.

The one thing on screen that says an order was received is the marker ring at
its destination, which clears itself on arrival.

### Structures

A nexus carries a networked `Shield` component and takes no damage while its own
team still has a tower standing. Shielded structures are excluded from target
selection, so nothing wastes a swing on one. The shield is recomputed every tick
rather than hooked to tower death: it is six entities of work, it cannot drift
out of sync, and it is correct across a match reset without the reset knowing
about it.

### Tower aggro

Priority order:

1. an enemy champion that attacked one of ours inside this tower's range within
   `TOWER_CHAMPION_AGGRO_SEC`;
2. the nearest enemy minion;
3. the nearest enemy champion.

The aggro stamp is written in `server/damage.ts`, not in the ability handlers,
so every path by which a champion can hurt another champion counts.

### Minions

Waves are `MINIONS_MELEE_PER_WAVE` melee minions followed by casters, spawned in
ranks abreast. Melee hold the frontline; casters are frailer, out-range the
melee rank and hit champions harder. They are two entity kinds sharing one stat
table keyed by kind (`MINION_STATS`).

The formation is load-bearing. A minion attacks only what is inside its own
range, so how many of a wave can fight at once is set by how wide it is, not by
how many minions it holds. In single file about three ever make contact no
matter how long the queue behind them, which caps the rate the two sides kill
each other at roughly the rate they spawn.

That was the state this lane was actually in, measured with `bun run probe`:

| Formation | Minions per side | Engaged | Frontline | Tower after 100s |
| --- | --- | --- | --- | --- |
| Single file, speed 1.5 | 12 to 18 | 3 | frozen at mid | untouched |
| Ranks abreast, speed 2.5 | 6 to 9 | 1 to 3 of 9 | oscillating | takes damage |

The lane filled with minions that never advanced and could not be cleared: a
champion facing fifteen of them cannot break the line, so no wave ever reached a
tower. Widening the wave and raising minion speed to `2.5` (which makes the
crossing to mid take `MINION_SPAWN_INTERVAL_SEC`, so waves arrive as whole
groups rather than trickling in) brings the standing population down to
something a champion can clear. Clearing the enemy wave then produces a real
push: measured at 149 tower health in the eight seconds before the next wave
arrived.

`vsMinion` and `speed` are therefore not feel numbers, they are the population
control. Change them with the probe open.

### Abilities

| Key | Ability | Cooldown | Effect |
| --- | --- | --- | --- |
| Space or left click | Attack | 1s | `ATTACK_DAMAGE` to the legal target nearest the aim point |
| Q | Cleave | 6s | `CLEAVE_DAMAGE` to every enemy within `CLEAVE_RANGE` |
| E | Potion | 30s | `POTION_HEAL_TOTAL` over `POTION_DURATION_SEC`, through damage |
| F | Dash | 12s | `DASH_DISTANCE` displacement along the steering direction |

The potion is the only healing that works while taking damage. Out-of-combat
regeneration already covers walking home, so an interruptible potion would add
nothing. At 10 HP/s it loses to a champion (18 DPS) and to a tower (22 DPS), and
beats a minion wave (4-5 DPS).

The dash is instant and server-resolved, not predicted, which keeps the movement
state machine in one place. `Position` is synced with `interp: 'lerp'`, so other
clients see the displacement interpolated. The client sends direction only; the
server normalises it and owns the distance. Collision is not consulted, because
`resolveCollisions` runs at the end of the tick and pushes the champion clear,
which is what lets a dash cross a minion wall. A dash into a lane boundary is
refused rather than spending the cooldown on a no-op, as is a potion at full
health.

Attack and cleave spend their cooldown even on a miss. Potion and dash do not,
because a refused one does nothing at all.

### Respawn

`RESPAWN_BASE_SECONDS` plus `RESPAWN_PER_DEATH_SECONDS` per death already taken,
capped at `RESPAWN_MAX_SECONDS`. The client cannot derive this, so the server
quotes it with a `respawnIn` RPC. The quote can arrive either side of the
despawn that starts the countdown, so the client stores it and corrects a
running timer.

### Aim

`attack` carries the world point the attacker is pointing at. The server picks
the closest legal target to that point, where legal means alive, hostile, not
shielded, and inside `ATTACK_RANGE`. Range and hostility remain server-side, so
aim can only rank candidates that were already hittable.

It carries a point rather than an entity id because entity ids are not a shared
namespace: `GameClient` keeps its own local ids and its server-to-local map is
private. Positions are networked, so they are the one vocabulary both sides
share.

### Match lifecycle

A match ends when a nexus falls. The server rebuilds the arena
`MATCH_RESET_SECONDS` later. One `over` flag lives in `server/match.ts`; every
system reads it, and `server/damage.ts` is the single place that knows what a
death means.

### Filling the teams

Six seats, three a side, and the arena is shared: one server, one lane, whoever
is connected. How they get filled is one rule with two halves.

**Bots fill the seats nobody wants.** The menu's 1v1, 2v2 and 3v3 buttons send
`fillTeams`, which names a size rather than asking for one more bot. Being a
target is what makes it idempotent, so a reconnect re-sending it is a no-op, and
it is the only shape that can lower a size as well as raise one.
`rebalanceBots` is the single place the AI head-count is decided, and it takes
the largest of the requested size and either side's human count: three people on
one side means the other side needs three champions whatever was asked for,
which is also what keeps the sides even without a separate parity pass.

**People outrank bots, always.** A human arriving evicts one rather than being
turned away, so a bot can never cost somebody a game. That eviction goes through
the full removal path on purpose: `Roster.evictableBot` reports which bot should
go and the host removes it, because freeing the seat inside `joinHuman` handed
the caller a `Player` whose `entity` had already been nulled, and the bot's
champion was then left walking the lane with nobody owning it.

**Spectating therefore means six humans and nothing else.** The seventh arrival
is told so with a `spectating` RPC, which it cannot work out for itself: a
seated player learns it is seated from `assignEntity`, but a player with no seat
receives nothing at all, and "no champion yet" is indistinguishable from a slow
connection. The wait ends without them asking, because `seatWaiting` hands the
next free seat over in arrival order.

When the last human leaves, the requested size is forgotten and the bots go with
it, rather than shadow-boxing in an empty lane forever.

### How bots play

Bots move with `stepChampion` and resolve abilities through the same
`server/abilities.ts` functions as players, so they are bound by identical
ranges, cooldowns and distances. What differs is judgement: they hold with their
wave, cap their advance at the enemy's frontmost standing structure, avoid tower
range without minions to soak it, retreat with hysteresis, drink above their
retreat threshold, dash to escape before dashing to engage, and pause
`BOT_REACTION_*` after each cooldown expires so their attack cadence is not
frame-perfect.

## Controls

| Input | Action |
| --- | --- |
| WASD | Move. Team-relative: W is always toward the enemy base |
| Right mouse button | Walk to that point, routed around structures. Any movement key cancels it |
| Space or left mouse button | Attack. Either binding repeats while held, on every cooldown. Requires the cursor over an enemy in range |
| Q | Cleave |
| E | Potion |
| F | Dash |
| M | Mute |

Camera and controls both derive from `forwardZ(team)`. Anything needing "which
way is forward" (camera offset, WASD axes, minion marching, spawn points, wave
stagger, minimap orientation) goes through that one helper.

Both movement schemes are always live; there is nothing to switch between them.
See [Movement](#movement) for how they share one champion.

## HUD

| Position | Contents |
| --- | --- |
| Top left | Connection status, ping, mute, leave and surrender |
| Top centre | Team kills, match clock, head count, own K/D |
| Top right | Kill feed |
| Bottom centre | Own health, hotbar, enemy-tower warning, or the spectating notice in place of all three |
| Bottom right | Minimap |
| Over the world | Health bars, damage numbers, ground rings |

The match clock is broadcast once a second rather than counted locally, so a
player joining mid-match sees the same time as everyone else. The minimap is
drawn from data the client already holds and is always oriented from the
viewer's own side.

Three ground rings are drawn. Attack range is always visible and brightens when
the cursor is over an enemy that is also in reach. An enemy tower's range is
drawn only while the champion is inside it: four permanent danger zones become
scenery, whereas one that appears on crossing the line is itself the warning.
The third marks where a click-to-move order is headed, and is the only thing
that distinguishes "walking where I asked" from a click that missed.
Friendly tower ranges are not drawn, because a ring meaning "safe" and a ring
meaning "under fire" would be hard to tell apart at a glance.

All on-screen text is Portuguese and contains no em dashes.

## Balance

Values live in `shared/constants.ts` and are tuned in hits, since every unit
attacks once per second.

| Interaction | Result |
| --- | --- |
| Tower to melee minion | 3 shots |
| Tower to caster minion | 2 shots |
| Champion to melee minion | 3 hits, or 1 cleave and 1 hit |
| Champion to caster minion | 2 hits, or 1 cleave |
| Champion to champion | 8 hits |
| Tower to champion | 7 shots |
| Minion to minion | 5 hits |
| Full wave to tower | about 15s |

Three constraints are load-bearing:

- Tower damage stays below both minions' health. A tower that one-shots minions
  clears waves faster than they arrive and the lane layer becomes decorative.
- Champions respawn behind their own nexus. In front is exactly where an
  attacker must stand, which turns every death into a spawn camp once the towers
  fall. `SPAWN_AREA_DEPTH` makes that area reachable.
- Champions regenerate out of combat. Without it, surviving at low health is
  strictly worse than dying, and the bot's retreat has no meaning because
  nothing can heal it.

## Verification

```bash
bun run typecheck && bun run rules && bun run smoke
```

`scripts/rules-check.ts` builds an `Arena`, registers the real systems and
places entities exactly where a rule needs them. It covers the nexus shield,
tower aggro and its expiry, potion healing through damage, dash distance and
refusal, that a never-used ability is off cooldown, and death reporting. No sockets are involved, because these rules need
specific units at specific health in specific places.

Its last two sections are client code, and belong there for the same reason.
Click-to-move is decided entirely on the client, but none of that decision needs
a canvas, a renderer or a socket. They cover `screenToGround` inverting
`worldToScreen` on the ground plane, a click above the horizon having no ground
point at all, an order across open ground, arrival clearing the order, a path
bending around a tower without ever walking through it, re-planning when that
tower falls, clamping and rim-pushing, and that a movement key cancels the
destination on the spot. The camera matrix the first two need is assembled in
the script, since `Camera3D` needs a GPU device to construct.

The one link neither script covers is the mouse listener that turns a right
click into an order. `public/harness.html` has `__rightClick(x, y)` and
`__ordered()` for that.

`scripts/smoke-client.ts` runs real `GameClient`s over a real WebSocket. It
covers seating, that forward advances both teams toward the enemy, aim
precedence over proximity, cleave broadcast and cooldown, potion and dash
broadcasts, wave composition, shielded nexuses, surrender and spawn-slot reuse.

It also covers the whole of how seats are filled, which only exists once there
are peers: 3v3 filling both teams, asking twice changing nothing, a bot taking
over a seat a human left, a human evicting one back, lowering the size without
going below the people already playing, six humans filling the arena between
them, and a seventh being told it is spectating and then seated the moment
somebody leaves. Team sizes there are read off the `score` RPC rather than
counted from champions on the board: a champion that just died is gone from the
world for the seconds its respawn takes while its seat is still taken, and
counting entities made every one of those checks flap.

Both are written to be deterministic. Where the game is genuinely racy, they
wait on the condition rather than sleeping. The smoke test takes real spawn
slots, so it refuses to run against a server that already has champions in it.
Adding an RPC changes the wire contract, so every client must be reloaded after
a protocol change.

Neither covers rendering. `public/harness.html` serves that: the game client on
a bare canvas, no HUD, with `requestAnimationFrame` replaced by a `setTimeout`
shim so the loop runs in a tab that is not compositing. It exposes `__hud`,
`__logs`, `__key()`, `__rightClick()`, `__ordered()`, `__shot()` and `__crop()`;
the latter two post frames to `bun run capture`, which writes PNGs to
`captures/`.

A tab that is not compositing also never delivers `ResizeObserver`
notifications, so the canvas keeps whatever size it had when the renderer read
it. If that was zero the aspect ratio is `NaN`, and every overlay ends up
positioned at `NaN` horizontally while its vertical position stays correct: a
distinctive signature, and not a bug in whatever was being changed at the time.

`render()` is wrapped in a `try`/`catch` because an exception thrown inside a
rAF callback kills the loop silently and leaves a blank canvas with no other
symptom.

## Assets

Models are CC-BY-4.0; see [CREDITS.md](CREDITS.md).

Champions render as the minion's golem model scaled to champion height.
`public/models/hero/` is the intended champion model and does not render under
Murow at all: no exception, no WebGPU validation error, no warning. Ruled out:
the instancing path, the animation clips, the skinned instance budget, and
interaction between the two skinned models. What remains is the rig itself, 239
joints across 5 skinned parts against the golem's 28 in 1. Fixing it means
debugging Murow's GLTF skin parsing and its skeletal-animation kernel, and
expressing the fix as a fourth build-time patch.

To restore it: register the prefab in `src/game-client.ts` and point
`KIND_CHAMPION.modelId` back at `model-hero` with `GLTF_SCALE_CHAMPION`.

Caster minions reuse the same golem, smaller and tinted harder, because there is
only one minion rig.

## Known limitations

- The champion GLTF does not render, so champions and caster minions borrow the
  golem model.
- Facing is derived client-side from movement deltas. Nothing on the wire
  carries a heading, so it is cosmetic and never affects targeting.
- A basic attack is drawn only for the player who threw it. Others infer it from
  the victim's health dropping.
- The kill feed names teams, not players. Peer ids are not names and there is no
  display name anywhere in the stack.
- No items, no levels, one lane, no fog of war.

## Reference

[docs/NEWSTACK.md](docs/NEWSTACK.md) is a full Newstack API reference for tools
that need it as context.
