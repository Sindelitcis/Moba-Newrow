/* ---------- External ---------- */
import Newstack, { type NewstackClientContext } from "@moureau/newstack";

/* ---------- Game ---------- */
// Straight at the leaf modules, not the `../shared` barrel: the barrel also
// re-exports `arena.ts` and `predictions.ts`, which import `murow` and
// `murow/netcode`: pulling the whole engine into Newstack's esbuild bundle
// (and into its Node-run server process) for the sake of a few constants.
// `constants.ts` imports only `kinds.ts`, and `teams.ts` only `constants.ts`;
// none of the three import anything outside `shared/`.
import {
  ATTACK_COOLDOWN_TICKS,
  CLEAVE_COOLDOWN_TICKS,
  DASH_COOLDOWN_TICKS,
  POTION_COOLDOWN_TICKS,
  TICK_RATE,
} from "../shared/constants";
import { TEAM_A } from "../shared/teams";
import {
  EMPTY_SCORE,
  type ConnectionStatus,
  type FeedEntry,
  type GameHandle,
  type MatchResult,
  type ScoreState,
  type SelfState,
} from "./game/api";

/**
 * @description
 * The MOBA 3x3 page. Newstack owns the page shell (canvas ref + HUD);
 * everything inside the canvas, rendering, netcode, input, is Murow's.
 *
 * `game-client.ts` is built as its own standalone bundle (see vite.config.ts)
 * and loaded here via a plain `<script>` tag instead of a regular import.
 * Newstack's own esbuild pipeline bundles this file, and if it also pulled in
 * `murow/webgpu` directly, the WebGPU renderer's `tgpu.fn` shaders end up
 * bundled twice (once already inside Murow's own published dist, once again
 * here): the resulting identifier collisions break TypeGPU's runtime
 * shader-metadata resolution. Keeping the two bundlers' module graphs
 * completely separate avoids that, which is also why the types above come from
 * `game/api` (type-only, fully erased at build time) rather than from the game
 * client itself.
 */

// Module-level (not a reactive `this` property) so checking it doesn't itself
// trigger a re-render, and so it's set truly synchronously: see the guard in
// `hydrate()` below for why that matters.
let hydrated = false;

const ATTACK_COOLDOWN_SECONDS = ATTACK_COOLDOWN_TICKS / TICK_RATE;
const CLEAVE_COOLDOWN_SECONDS = CLEAVE_COOLDOWN_TICKS / TICK_RATE;
const POTION_COOLDOWN_SECONDS = POTION_COOLDOWN_TICKS / TICK_RATE;
const DASH_COOLDOWN_SECONDS = DASH_COOLDOWN_TICKS / TICK_RATE;

/** How long a kill-feed line stays on screen, and how often expiry is checked. */
const FEED_LIFETIME_MS = 6000;
const FEED_SWEEP_MS = 1000;
/** Below this fraction the self health bar turns red: "you are about to die". */
const CRITICAL_HP_FRACTION = 0.3;

/**
 * Match sizes offered against bots, smallest first. Capped by
 * `PLAYERS_PER_TEAM`, which is what the server's spawn slots actually allow.
 */
const BOT_SIZES = [1, 2, 3] as const;

/** What each size actually gets you, given the player takes one of the seats. */
function botSizeHint(size: number): string {
  if (size === 1) return "Duelo, você contra um bot";
  return `Você e ${size - 1} bot${size > 2 ? "s" : ""} contra ${size} bots`;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "conectando",
  connected: "conectado",
  reconnecting: "reconectando",
  disconnected: "desconectado",
};

function teamName(team: number): string {
  return team === TEAM_A ? "Azul" : "Vermelho";
}

/** The wording for one feed event. Kept here because the protocol carries codes, not text. */
function feedText(entry: FeedEntry): string {
  const team = teamName(entry.team);
  switch (entry.event) {
    case "firstBlood":
      return `Primeiro sangue para o time ${team}!`;
    case "kill":
      return `Time ${team} abateu um campeão`;
    case "towerDown":
      return `Torre do time ${team} destruída`;
    case "nexusExposed":
      return `Nexus do time ${team} está exposto!`;
  }
}

/** `M:SS`, the way every MOBA writes a match clock. */
function clockText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

interface TimedFeedEntry extends FeedEntry {
  bornAt: number;
}

export class Game extends Newstack {
  canvas!: HTMLCanvasElement;

  /**
   * `menu` until a mode is picked. The game client isn't started at all until
   * then: no WebSocket, no WebGPU device, no champion taking a spawn slot on
   * the shared server just because someone left the page open.
   */
  phase: "menu" | "playing" = "menu";
  /** Set while the bundle is still downloading, so the buttons can wait for it. */
  scriptReady = false;

  status: ConnectionStatus = "connecting";
  ping = 0;
  muted = false;
  clock = 0;

  result: MatchResult | null = null;
  nextMatchSeconds: number | null = null;
  respawnSecondsLeft: number | null = null;
  score: ScoreState = EMPTY_SCORE;
  self: SelfState | null = null;
  /** True while every seat is taken and this player is only watching. */
  spectating = false;
  feed: TimedFeedEntry[] = [];
  /** Two-step, so a stray click can't throw the match. */
  confirmingSurrender = false;

  /** 0 = ready, 1 = just used. Drives each hotbar slot's cooldown wipe. */
  attackCooldownFrac = 0;
  cleaveCooldownFrac = 0;
  potionCooldownFrac = 0;
  dashCooldownFrac = 0;
  /** True while standing inside an enemy tower's reach. */
  inTowerRange = false;

  private handle: GameHandle | null = null;
  private feedSweep: ReturnType<typeof setInterval> | null = null;

  prepare({ page }: NewstackClientContext) {
    page.title = "MOBA 3x3";
  }

  hydrate() {
    // Newstack has been observed calling `hydrate()` twice back-to-back,
    // synchronously, for a single real mount (no `destroy()` in between).
    // Guarding on `this.handle` alone doesn't catch that: it's only set once
    // the script's `onload` fires (async), so a second synchronous `hydrate()`
    // call sees `this.handle` still null and races right past the same check -
    // this flag is set immediately, before any async work, so the second call
    // actually gets blocked.
    if (hydrated) return;
    hydrated = true;

    const script = document.createElement("script");
    // Cache-busted: this file is a static asset rebuilt by `vite build` (see
    // vite.config.ts), not something Newstack's own dev server
    // watches/versions: without this, browsers happily keep serving a stale
    // cached bundle across rebuilds.
    script.src = `/game-client.js?v=${Date.now()}`;
    script.onload = () => { this.scriptReady = true; };
    document.body.appendChild(script);

    // One sweep for the whole feed rather than a timer per entry: entries
    // arrive in bursts (a cleave through a wave, a tower falling as someone
    // dies) and a timer each would be a timer each to clean up on teardown.
    this.feedSweep = setInterval(() => this.expireFeed(), FEED_SWEEP_MS);
  }

  private expireFeed() {
    if (this.feed.length === 0) return;
    const cutoff = Date.now() - FEED_LIFETIME_MS;
    const kept = this.feed.filter((entry) => entry.bornAt > cutoff);
    if (kept.length !== this.feed.length) this.feed = kept;
  }

  /**
   * Leaves the menu and actually connects. `botsPerTeam` is the size to keep
   * the arena at with AI, or 0 for pure PvP.
   *
   * One object argument, per Newstack's convention: its component proxy merges
   * the live context into whatever object a method is called with, so the
   * parameter names only what the *caller* has to supply. Positional arguments
   * would be dropped by that same merge.
   */
  start({ botsPerTeam }: { botsPerTeam: number }) {
    const init = window.__initMobaGame;
    if (this.handle !== null || init === undefined) return;

    this.phase = "playing";
    this.status = "connecting";
    this.result = null;
    this.nextMatchSeconds = null;
    this.respawnSecondsLeft = null;
    this.score = EMPTY_SCORE;
    this.self = null;
    this.spectating = false;
    this.feed = [];
    this.clock = 0;
    this.inTowerRange = false;
    this.confirmingSurrender = false;

    this.handle = init(
      this.canvas,
      {
        onStatus: (status) => { this.status = status; },
        onPing: (ms) => { this.ping = ms; },
        onMuted: (muted) => { this.muted = muted; },
        onClock: (seconds) => { this.clock = seconds; },
        onMatchOver: (result) => { this.result = result; },
        onNextMatchIn: (seconds) => { this.nextMatchSeconds = seconds; },
        onRespawn: (secondsLeft) => { this.respawnSecondsLeft = secondsLeft; },
        onScore: (score) => { this.score = score; },
        onSelf: (self) => { this.self = self; },
        onSpectating: (spectating) => { this.spectating = spectating; },
        onFeed: (entry) => { this.feed = [...this.feed, { ...entry, bornAt: Date.now() }]; },
        onAttackCooldown: (frac) => { this.attackCooldownFrac = frac; },
        onCleaveCooldown: (frac) => { this.cleaveCooldownFrac = frac; },
        onPotionCooldown: (frac) => { this.potionCooldownFrac = frac; },
        onDashCooldown: (frac) => { this.dashCooldownFrac = frac; },
        onTowerDanger: (inRange) => { this.inTowerRange = inRange; },
      },
      { botsPerTeam },
    );
  }

  /** Concede: the server ends the match and rebuilds the arena for everyone. */
  surrender() {
    if (!this.confirmingSurrender) {
      this.confirmingSurrender = true;
      return;
    }
    this.confirmingSurrender = false;
    this.handle?.surrender();
  }

  /** Back to the menu: drops the connection and frees the spawn slot. */
  leave() {
    this.handle?.dispose();
    this.handle = null;
    this.phase = "menu";
    this.confirmingSurrender = false;
  }

  destroy() {
    this.handle?.dispose();
    this.handle = null;
    if (this.feedSweep !== null) clearInterval(this.feedSweep);
    this.feedSweep = null;
    hydrated = false;
  }

  private renderMenu() {
    return (
      <div class="menu">
        <div class="menu-card">
          <h1 class="menu-title">MOBA 3x3</h1>
          <p class="menu-sub">Uma lane, duas bases, quatro torres.</p>

          <div class="menu-label">Contra bots</div>
          <div class="menu-sizes">
            {BOT_SIZES.map((size) => (
              <button
                class={`menu-button size ${size === 3 ? "primary" : ""}`}
                disabled={!this.scriptReady}
                onclick={() => this.start({ botsPerTeam: size })}
              >
                {size}v{size}
                <span class="menu-hint">{botSizeHint(size)}</span>
              </button>
            ))}
          </div>

          <button
            class="menu-button"
            disabled={!this.scriptReady}
            onclick={() => this.start({ botsPerTeam: 0 })}
          >
            PvP
            <span class="menu-hint">Entre e espere outros jogadores (até 3 por time)</span>
          </button>

          <div class="menu-rules">
            <div><b>Destrua as torres</b> antes do nexus: ele fica protegido enquanto elas estiverem de pé.</div>
            <div><b>Cuidado com as torres:</b> ataque um campeão perto de uma e ela mira em você.</div>
            <div><b>Ande com sua wave.</b> Sozinho na lane você é alvo fácil.</div>
            <div><b>Beba a poção</b> na hora certa: ela cura durante a briga, mas demora a voltar.</div>
            <div><b>O dash</b> atravessa a linha de minions e quebra a distância de ataque.</div>
            <div><b>Clique direito</b> anda até o ponto, desviando das torres. Qualquer tecla de movimento cancela o trajeto.</div>
          </div>

          <div class="menu-controls">
            <b>WASD</b> ou <b>clique dir.</b> mover &middot;
            {" "}<b>Espaço</b> ou <b>clique esq.</b> atacar &middot;
            {" "}<b>Q</b> girar &middot; <b>E</b> poção &middot; <b>F</b> dash &middot; <b>M</b> som
          </div>
          {!this.scriptReady && <div class="menu-loading">Carregando…</div>}
        </div>
      </div>
    );
  }

  private renderTopBar() {
    return (
      <div class="topbar">
        <span class="score-team team-0">{this.score.killsA}</span>
        <span class="topbar-clock">{clockText(this.clock)}</span>
        <span class="score-team team-1">{this.score.killsB}</span>
        <div class="topbar-sub">
          {this.score.sizeA}v{this.score.sizeB} &middot; você {this.score.selfKills}/{this.score.selfDeaths}
        </div>
      </div>
    );
  }

  private renderFeed() {
    return (
      <div class="feed">
        {this.feed.map((entry) => (
          <div class={`feed-line team-${entry.team} ${entry.event}`}>{feedText(entry)}</div>
        ))}
      </div>
    );
  }

  private renderSelfBar() {
    if (this.self === null) return null;
    const fraction = this.self.max > 0 ? this.self.current / this.self.max : 0;
    const critical = fraction <= CRITICAL_HP_FRACTION;
    return (
      <div class="self-bar">
        <div class={`self-bar-fill team-${this.self.team} ${critical ? "critical" : ""}`}
             style={`width: ${Math.max(0, fraction) * 100}%`}></div>
        <div class="self-bar-text">{Math.max(0, Math.round(this.self.current))} / {this.self.max}</div>
      </div>
    );
  }

  /**
   * One hotbar slot. The wipe drains top-down and the number counts down with
   * it, so the slot answers "can I press this?" and "how long?" without a
   * second glance.
   *
   * Long cooldowns get whole seconds and short ones a decimal: "27" is what you
   * want to know about the potion, "0.4" is what you want to know about a swing.
   */
  private renderSlot(slot: {
    icon: string;
    key: string;
    fraction: number;
    total: number;
    extra?: string;
  }) {
    const left = slot.fraction * slot.total;
    const label = slot.total >= 10 ? Math.ceil(left).toString() : left.toFixed(1);
    const state = slot.fraction > 0 ? "cooling" : "ready";
    return (
      <div class={`hotbar-slot ${state} ${slot.extra ?? ""}`}>
        <div class="hotbar-icon">{slot.icon}</div>
        <div class="hotbar-cd-overlay" style={`height: ${slot.fraction * 100}%`}></div>
        {left > 0.05 && <div class="hotbar-cd-text">{label}</div>}
        <div class="hotbar-key">{slot.key}</div>
      </div>
    );
  }

  private renderHotbar() {
    return (
      <div class="hotbar">
        {this.renderSlot({
          icon: "⚔", key: "Espaço / clique",
          fraction: this.attackCooldownFrac, total: ATTACK_COOLDOWN_SECONDS,
        })}
        {this.renderSlot({
          icon: "🌀", key: "Q",
          fraction: this.cleaveCooldownFrac, total: CLEAVE_COOLDOWN_SECONDS,
        })}
        {this.renderSlot({
          icon: "🧪", key: "E", extra: "potion",
          fraction: this.potionCooldownFrac, total: POTION_COOLDOWN_SECONDS,
        })}
        {this.renderSlot({
          icon: "»", key: "F", extra: "dash",
          fraction: this.dashCooldownFrac, total: DASH_COOLDOWN_SECONDS,
        })}
      </div>
    );
  }

  private renderMatchOver() {
    if (this.result === null) return null;
    return (
      <div class="match-over">
        <div class={`match-over-title team-${this.result.winner}`}>
          Time {teamName(this.result.winner)} venceu!
        </div>
        <div class="match-over-score">
          <span class="team-0">{this.result.killsA}</span>
          <span class="match-over-dash">×</span>
          <span class="team-1">{this.result.killsB}</span>
        </div>
        <div class="match-over-self">
          Seus abates: {this.score.selfKills} &middot; mortes: {this.score.selfDeaths}
        </div>
        {this.nextMatchSeconds !== null && (
          <div class="match-over-next">
            Próxima partida em {Math.ceil(this.nextMatchSeconds)}s
          </div>
        )}
      </div>
    );
  }

  private renderHud() {
    return (
      <>
        <div class="hud">
          <div class="hud-title"><b>MOBA 3x3</b></div>
          <div class="hud-line">
            <span class={`status ${this.status}`}>{STATUS_LABEL[this.status]}</span>
            <span class="hud-ping">{this.ping} ms</span>
            {this.muted && <span class="muted-tag">sem som</span>}
          </div>
          <div class="hud-actions">
            <button class="hud-button" onclick={() => this.leave()}>Sair para o menu</button>
            {/* Nothing to concede without a champion, so a spectator is not
                offered the button at all rather than being shown a dead one. */}
            {!this.spectating && (
              <button
                class={this.confirmingSurrender ? "hud-button danger" : "hud-button"}
                onclick={() => this.surrender()}
                onmouseleave={() => { this.confirmingSurrender = false; }}
              >
                {this.confirmingSurrender ? "Confirmar desistência?" : "Desistir"}
              </button>
            )}
          </div>
        </div>

        {this.renderTopBar()}
        {this.renderFeed()}
        {this.renderMatchOver()}

        {this.result === null && this.respawnSecondsLeft !== null && (
          <div class="respawn-overlay">
            <div class="respawn-title">Você morreu</div>
            <div>Renascendo em {Math.ceil(this.respawnSecondsLeft)}s</div>
          </div>
        )}

        {(this.status === "reconnecting" || this.status === "disconnected") && (
          <div class="reconnect-overlay">
            {this.status === "reconnecting"
              ? "Conexão perdida, reconectando…"
              : "Desconectado"}
          </div>
        )}

        {/* The hotbar and the health bar describe a champion this player does
            not have, so a spectator gets the reason instead of a row of keys
            that do nothing. The seat arrives on its own: the server hands one
            over the moment somebody leaves. */}
        <div class="bottom-hud">
          {this.spectating ? (
            <div class="spectating">
              <b>Assistindo</b>
              <span>Os seis lugares estão ocupados. Você entra assim que abrir uma vaga.</span>
            </div>
          ) : (
            <>
              {this.inTowerRange && (
                <div class="tower-warning">No alcance da torre inimiga</div>
              )}
              {this.renderSelfBar()}
              {this.renderHotbar()}
            </>
          )}
        </div>
      </>
    );
  }

  render() {
    return (
      <div class="game-root">
        <canvas ref={this.canvas} id="gameCanvas"></canvas>
        {this.phase === "menu" ? this.renderMenu() : this.renderHud()}
      </div>
    );
  }
}
