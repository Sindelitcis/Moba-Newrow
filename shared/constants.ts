/**
 * Wire / world constants shared by server and client. Single source of truth
 * so both sides agree without duplicating numbers.
 *
 * Imports nothing but `./kinds` (which imports nothing at all) on purpose:
 * `src/Game.tsx` reaches straight in here rather than through the `../shared`
 * barrel, which would drag Murow into Newstack's bundle.
 */
import { KIND_MINION, KIND_MINION_CASTER } from './kinds';

// --- Transport -------------------------------------------------------------

/** WebSocket upgrade path on the game server (separate Bun process, see game-server.ts). */
export const WS_PATH = '/ws';

/**
 * Port of the Bun game server. Separate process/port from the Newstack page
 * server: the client connects here directly regardless of which port served
 * the page. See the README's "Architecture" section for why they can't share
 * a runtime.
 */
export const GAME_SERVER_PORT = 3010;

/** Logic ticks per second. Both sides must run the same rate for prediction to match. */
export const TICK_RATE = 20;

// --- The lane --------------------------------------------------------------

/** World units per second for champion movement. */
export const MOVE_SPEED = 4;

/** Half-length of the lane along Z. Bases sit at ±LANE_HALF. */
export const LANE_HALF = 20;
/** Half-width of the lane along X: how far champions can strafe off-center. */
export const LANE_WIDTH_HALF = 5;

/**
 * Depth of the spawn area *behind* each base, and how far behind the base a
 * champion actually appears.
 *
 * Behind, not in front: a champion respawning in front of its own nexus
 * respawns exactly where an enemy attacking that nexus has to stand, so
 * losing your towers turned every death into a spawn-camp. Putting the spawn
 * on the far side of the base gives a respawning player the width of their
 * own nexus as breathing room. The lane clamp has to allow for it, which is
 * what `SPAWN_AREA_DEPTH` is for.
 */
export const SPAWN_AREA_DEPTH = 3;
export const CHAMPION_SPAWN_SETBACK = 2;

/**
 * Slack past each end of the lane. Collision may shove a unit out this far
 * (pushing back into the lane shouldn't be what clips movement), and a minion
 * that gets past it is assumed to have missed everything and is despawned.
 * One number so the two can't drift into a state where a minion is parked
 * just outside the despawn bound forever.
 */
export const LANE_OVERRUN = 5;

/** Distance from center for each team's outer/inner tower. */
export const TOWER_OUTER_Z = 14;
export const TOWER_INNER_Z = 7;

// --- Balance ---------------------------------------------------------------

/**
 * Health pools per kind.
 *
 * These and the damage numbers below are tuned as one set: every value is
 * chosen for how many *hits* it takes, since everything in this game swings
 * once per second. The tuning targets, all deliberate:
 *
 *   tower  -> melee minion   3 shots  (it used to be 1: a 25-damage shot
 *                                      against a 20 HP minion deleted waves on
 *                                      contact, so minions never reached
 *                                      anything)
 *   tower  -> caster minion  2 shots  (the squishy back rank)
 *   champion -> melee minion 3 hits, or 1 cleave + 1 hit
 *   champion -> caster       2 hits, or 1 cleave
 *   champion -> champion     8 hits   (long enough to react and disengage)
 *   tower -> champion        7 shots  (diving is punished, not instantly fatal)
 *   minion -> minion         4 hits   (see MINION_STATS: this one is measured,
 *                                      not chosen, because it sets the standing
 *                                      minion population)
 *   wave -> tower            ~1/3 of it per wave that arrives with survivors,
 *                                     measured, not derived
 */
export const CHAMPION_HP = 140;
export const TOWER_HP = 450;
export const BASE_HP = 800;

/** Champion basic attack: range in world units, damage per hit, cooldown in ticks. */
export const ATTACK_RANGE = 2.2;
export const ATTACK_DAMAGE = 18;
export const ATTACK_COOLDOWN_TICKS = TICK_RATE; // ~1 attack/sec

/**
 * Champion cleave (the second ability): a spin that hits *every* enemy in a
 * radius around the caster, with no aiming at all: deliberately the opposite
 * trade-off from the basic attack, which is single-target and has to be
 * pointed at something. Wider and harder-hitting, on a much longer cooldown,
 * so clearing a minion wave is a decision rather than a rotation.
 */
export const CLEAVE_RANGE = 3.5;
export const CLEAVE_DAMAGE = 40;
export const CLEAVE_COOLDOWN_TICKS = TICK_RATE * 6; // ~1 cast / 6 sec

/**
 * Champion dash (the fourth ability): an instant displacement along the
 * direction the player is already steering.
 *
 * Distance is set against the ranges it has to interact with:
 *
 *   ATTACK_RANGE        2.2   clears it, so a dash breaks off a trade
 *   CLEAVE_RANGE        3.5   clears it
 *   TOWER_ATTACK_RANGE  6.0   does not clear it from the centre, so diving
 *                             under a tower still costs something
 *
 * At MOVE_SPEED it is a little over a second of walking, delivered at once.
 * The cooldown sits between the cleave's 6s and the potion's 30s: available
 * roughly every second minion wave, which makes engaging or disengaging a
 * decision rather than a rotation.
 */
export const DASH_DISTANCE = 4.5;
export const DASH_COOLDOWN_TICKS = TICK_RATE * 12; // ~1 use / 12 sec

/**
 * Champion potion (the third ability): the only healing in the game that works
 * *while you are being hit*.
 *
 * That exception is the whole design. Out-of-combat regen already covers
 * "walk home and come back", so a potion that also stopped under fire would
 * duplicate it and change nothing; healing through damage is what turns a lost
 * trade into a survivable retreat, and what makes holding the lane after a bad
 * trade a decision rather than a mistake.
 *
 * The numbers are picked against what actually shoots at you, all per second:
 *
 *   enemy champion   18  : out-damages the potion, so a straight duel is still
 *                           lost; it buys ~3 extra hits' worth of life, no more
 *   tower            22  : diving under one is not survivable, potion or not
 *   minion wave     4-5  : out-healed, so a wave alone can't push you out
 *
 * `POTION_HEAL_TOTAL` is ~43% of a champion's health, which sounds enormous
 * until you notice it arrives at 10/sec against an 18/sec opponent. The
 * cooldown is the real cost: at 30s it is roughly one potion every four minion
 * waves, so it is a decision about *when*, not a button to hold down.
 */
export const POTION_HEAL_TOTAL = 60;
export const POTION_DURATION_SEC = 6;
export const POTION_COOLDOWN_TICKS = TICK_RATE * 30; // ~1 use / 30 sec

/**
 * Respawn wait, in seconds: a flat base plus a penalty per death already
 * taken this match, capped.
 *
 * Flat timers make dying cheap late in a match, which is when it should cost
 * the most: a player who is 0-6 down should not be back in the lane as fast
 * as they were on the first death. The cap keeps a losing side from being
 * shut out of the game entirely.
 */
export const RESPAWN_BASE_SECONDS = 5;
export const RESPAWN_PER_DEATH_SECONDS = 1.5;
export const RESPAWN_MAX_SECONDS = 18;

/**
 * Champion health regeneration.
 *
 * Without this, surviving a fight at 10% HP is strictly worse than dying:
 * there is no way back to full short of being killed, so the only rational
 * play is to throw yourself at something. It also makes "walk home" a real
 * option instead of a dead end, which is exactly what the bot's retreat
 * behaviour depends on (see server/bot.ts).
 *
 * Regen is out-of-combat only, and much faster on your own doorstep, so
 * disengaging costs you the lane rather than nothing at all.
 */
export const CHAMPION_REGEN_DELAY_SEC = 5;
export const CHAMPION_REGEN_PER_SEC = 4;
/** Multiplier while standing in your own base's healing radius. */
export const CHAMPION_BASE_REGEN_MULTIPLIER = 4;
export const CHAMPION_BASE_REGEN_RADIUS = 6;
/**
 * How often regen is applied. Health is an integer, so ticking 0.2 HP twenty
 * times a second would truncate away to nothing: this accumulates it into
 * whole points instead.
 */
export const REGEN_INTERVAL_SEC = 0.5;

/**
 * Seconds the victory screen stays up before the server rebuilds the arena
 * and starts the next match. Long enough to register who won, short enough
 * that nobody reaches for the terminal: restarting the process used to be
 * the only way to play a second round.
 */
export const MATCH_RESET_SECONDS = 8;

// --- Minions ---------------------------------------------------------------

/** How often a wave leaves each base, and how many minions are in it. */
export const MINION_SPAWN_INTERVAL_SEC = 8;
export const MINIONS_PER_WAVE = 6;
/** How many of those are melee; the rest are casters, marching behind them. */
export const MINIONS_MELEE_PER_WAVE = 3;

/**
 * Wave formation: ranks abreast, melee in front.
 *
 * The width is load-bearing. A minion attacks only what is inside its own
 * range, so how many of a wave can fight at once is decided by how wide it is,
 * not how many minions it contains. In single file about three ever make
 * contact regardless of the queue behind them, which caps the rate the two
 * sides kill each other at roughly the rate they spawn: the lane then fills
 * with minions that never advance and cannot be cleared. Measured with
 * `scripts/lane-probe.ts`.
 *
 * `MINION_FILE_GAP` is wider than twice `MINION_RADIUS`, so a freshly spawned
 * rank is not already overlapping and does not spend its first seconds being
 * pushed apart by collision.
 */
export const MINIONS_PER_RANK = 3;
export const MINION_FILE_GAP = 1.3;
export const MINION_RANK_GAP = 1.4;

/**
 * Per-kind minion stats.
 *
 * A wave is two ranks with genuinely different jobs, the way a MOBA lane
 * works: melee minions are the wall that holds the frontline, casters stand
 * behind them and out-range it. Keeping the numbers in one table keyed by
 * kind, rather than as a flat set of `MINION_*` constants, is what makes
 * adding the second rank a data change instead of a fork in every system that
 * touches a minion.
 *
 * Minions swing on the same 1-attack/sec cadence as a champion's basic attack
 * (`ATTACK_COOLDOWN_TICKS`) rather than dealing damage every single tick.
 * `vsStructure` is deliberately the softest number of the three: it is what
 * stops a single surviving wave from flattening a tower in seconds: a wave
 * has to hold the ground in front of it for a while to take one down. And
 * `vsChampion` is soft too, because minions chip away, they don't duel.
 *
 * `vsMinion` and `speed` are different in kind from the rest. They are not
 * chosen for how a fight feels; they set the *standing minion population*,
 * which is an equilibrium between the spawn rate and a kill rate that depends
 * on how many minions can reach each other at once. Get it wrong and the lane
 * fills with minions that never advance and cannot be cleared: measured at 15
 * per side with the original 12/8 damage at speed 1.5, against 6 to 9 now.
 * That population decides whether a champion can break the line at all, so
 * change these two with `scripts/lane-probe.ts` open, not by eye.
 *
 * Speed also sets the wave cadence. At 2.5 a wave crosses the 20 units to mid
 * in eight seconds, which is `MINION_SPAWN_INTERVAL_SEC`, so waves arrive as
 * whole groups rather than trickling in and queueing behind the fight.
 */
export interface MinionStats {
    readonly hp: number;
    readonly speed: number;
    readonly attackRange: number;
    readonly vsMinion: number;
    readonly vsChampion: number;
    readonly vsStructure: number;
}

export const MINION_STATS: Readonly<Record<number, MinionStats>> = {
    [KIND_MINION]: {
        hp: 50,
        speed: 2.5,
        attackRange: 1.8,
        vsMinion: 16,
        vsChampion: 4,
        vsStructure: 5,
    },
    [KIND_MINION_CASTER]: {
        // Squishier and weaker against the wall of melee it hides behind, but
        // it out-ranges that wall and stings a champion harder, so diving the
        // back rank is a real decision rather than free.
        hp: 32,
        speed: 2.5,
        attackRange: 4.0,
        vsMinion: 11,
        vsChampion: 5,
        vsStructure: 4,
    },
};

// --- Towers ----------------------------------------------------------------

/**
 * Tower auto-attack: range, damage per hit, cooldown in ticks.
 *
 * Damage is deliberately below every minion's health: a tower that one-shots
 * minions removes waves faster than they arrive, which leaves the whole minion
 * layer decorative.
 */
export const TOWER_ATTACK_RANGE = 6;
export const TOWER_ATTACK_DAMAGE = 22;
export const TOWER_ATTACK_COOLDOWN_TICKS = TICK_RATE; // ~1 shot/sec

/**
 * Seconds a tower keeps its attention on a champion that attacked one of its
 * team's champions inside its range.
 *
 * Standard MOBA tower aggro, and the rule that makes towers *defend* rather
 * than just stand there: without it a diver could open on someone under their
 * own tower and take nothing back as long as a single minion was around to
 * hold the tower's attention.
 */
export const TOWER_CHAMPION_AGGRO_SEC = 3;

/**
 * Whether a nexus can be damaged while its own team still has a tower
 * standing.
 *
 * `false` is the MOBA shape: the lane has to actually be won before the base
 * is reachable, which is what makes towers objectives instead of scenery. With
 * it open from the first minute, the fastest way to win was to walk past
 * everything and hit the box.
 */
export const NEXUS_REQUIRES_TOWERS_DOWN = true;

// --- Bot -------------------------------------------------------------------

/**
 * Bot tuning. The bot plays through exactly the same rules as a player: same
 * champion, same speed, same cooldowns, same server-side ability resolution -
 * so everything here is about *judgement*, not about giving it an edge.
 */
/** How often the bot re-reads the board. A human doesn't re-plan 20x a second. */
export const BOT_DECISION_INTERVAL_SEC = 0.28;
/** HP fraction below which it disengages and walks home. */
export const BOT_RETREAT_HP_FRACTION = 0.35;
/** HP fraction it needs to recover before pushing out again. */
export const BOT_REENGAGE_HP_FRACTION = 0.75;
/** How far ahead of its own minions it is willing to stand. */
export const BOT_LEAD_DISTANCE = 2.5;
/** Extra clearance it keeps from an enemy tower when it has no minions to soak. */
export const BOT_TOWER_SAFETY_MARGIN = 1.5;
/**
 * How far short of its objective the bot stops. Inside `ATTACK_RANGE`, so it
 * can hit the structure, but it never walks *past* one, which is what kept it
 * standing on the enemy spawn point farming respawns.
 */
export const BOT_STRUCTURE_STANDOFF = 1.6;
/** Enemies inside cleave range before it spends the cooldown. */
export const BOT_CLEAVE_MIN_TARGETS = 2;
/**
 * HP fraction below which the bot drinks.
 *
 * Deliberately above `BOT_RETREAT_HP_FRACTION`: a potion is what a laner spends
 * to *avoid* having to walk home, so drinking only once already committed to
 * retreating would waste it. Players get the same option: this is the bot
 * choosing a moment, not a rule of its own.
 */
export const BOT_POTION_HP_FRACTION = 0.6;
/** Sideways wander, so it doesn't walk a machine-perfect straight line. */
export const BOT_STRAFE_AMPLITUDE = 1.4;
/**
 * Seconds the bot hesitates before swinging at something that just came into
 * reach.
 *
 * Its damage per hit is already identical to a player's: it is the *cadence*
 * that gives it away: with no delay it attacks on the exact tick each cooldown
 * expires, forever, which no human matches. This buys back the fraction of a
 * second a person spends noticing and clicking.
 */
export const BOT_REACTION_MIN_SEC = 0.25;
export const BOT_REACTION_MAX_SEC = 0.55;

// --- Presentation ----------------------------------------------------------

/**
 * Extra uniform multiplier on top of each GLTF file's own baked-in node
 * transforms (see `public/models/*`), chosen so each model ends up at the
 * `UNIT_HEIGHT_*` world height below.
 *
 * These are derived from the raw model dimensions *as Murow's GLTF parser
 * hands them to the renderer*, which is not the same thing as the model's
 * nominal size in a DCC tool: the parser bakes only the mesh-holding node's
 * own local transform and skips vertex baking entirely for skinned meshes, so
 * every ancestor transform (including the ~0.01 scale Sketchfab exports put on
 * a parent node) is silently dropped. `scripts/measure-gltf-scale.py`
 * reproduces exactly that, and its numbers match what the renderer measures.
 *
 * If a model is ever swapped out, re-run the script rather than guessing.
 */
export const GLTF_SCALE_CHAMPION = 0.87;   // 2.071 raw height -> ~1.8
export const GLTF_SCALE_TOWER = 0.2576;    // 17.467 raw *depth* -> ~4.5, see GLTF_ROTATION_TOWER
export const GLTF_SCALE_MINION = 0.0066;   // 152.5 raw height -> ~1.0

/**
 * The tower model is authored Z-up: its 17.47-unit long axis is Z, with X/Y
 * being the 5.6 x 6.0 footprint. Its `scene.gltf` *does* carry the usual
 * Sketchfab -90deg X correction, but on the node one level *above* the one
 * holding the mesh, and Murow's GLTF parser only bakes the mesh-holding node's
 * own local transform (it looks the node up with
 * `nodes.find(n => n.mesh === meshIdx)` and never walks up to its ancestors,
 * see packages/murow/src/renderer/gltf/parser.ts). So the correction is
 * silently dropped and the tower renders lying on its side down the lane.
 *
 * Re-applying it per instance is the fix that stays inside this project. After
 * the rotation the raw +Z axis becomes +Y, and since the mesh's Z range starts
 * at 0 the model is conveniently feet-at-origin, so it needs no extra Y
 * offset.
 *
 * The champion and minion don't need this: both are authored Y-up with their
 * feet at Y=0, and being skinned meshes the parser deliberately skips vertex
 * baking for them anyway (the skin's joint hierarchy places them).
 */
export const GLTF_ROTATION_TOWER: readonly [number, number, number] = [-Math.PI / 2, 0, 0];

/**
 * World-space height of each kind as it ends up on screen: used for HP bar
 * placement above the model's head and for mouse-hover hit-testing. For the
 * GLTF kinds this is raw height × the scale above; the base is assembled from
 * cubes instead (see src/game/nexus.ts) and this is the height of that
 * assembly.
 */
export const UNIT_HEIGHT_CHAMPION = 1.8;
export const UNIT_HEIGHT_MINION = 1.0;
/** Casters render slightly smaller, so the two ranks read apart at a glance. */
export const UNIT_HEIGHT_MINION_CASTER = 0.85;
export const UNIT_HEIGHT_TOWER = 4.5;
export const UNIT_HEIGHT_BASE = 3.2;

/**
 * Collision radii per kind (world units): treats every footprint as a circle
 * for simple circle-vs-circle push-apart collision (see server/collision.ts).
 * Roughly half of each kind's visual scale.
 */
export const CHAMPION_RADIUS = 0.45;
export const TOWER_RADIUS = 0.55;
export const BASE_RADIUS = 1.2;
export const MINION_RADIUS = 0.25;
