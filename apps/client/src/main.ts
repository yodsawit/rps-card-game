import "./style.css";
import { io, type Socket } from "socket.io-client";
import type { Card, CardSymbol, LaneResult } from "@rps/game-core";
import type {
  Ack,
  BattleSideView,
  ClientToServerEvents,
  LobbySnapshot,
  MatchSnapshot,
  PublicPlayerView,
  ServerSnapshot,
  ServerToClientEvents,
  SessionReceipt
} from "@rps/protocol";
import { startEffects } from "./fx.js";
import { GameAudio } from "./audio.js";

const SESSION_KEY = "rps-session-v1";
const NAME_KEY = "rps-player-name";
const LANE_NAMES = ["LEFT", "CENTER", "RIGHT"] as const;

interface PokerPosition {
  playerId: string;
  x: number;
  y: number;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
const toast = document.querySelector<HTMLDivElement>("#toast")!;
const audioControls = document.querySelector<HTMLDivElement>("#audio-controls")!;
if (!app || !toast || !audioControls) throw new Error("Application shell is missing.");

const effects = startEffects();
const gameAudio = new GameAudio(audioControls);

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]!);
}

function readSession(): SessionReceipt | null {
  try {
    const value = localStorage.getItem(SESSION_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as SessionReceipt;
    return parsed.roomCode && parsed.playerId && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

function symbolLabel(symbol: CardSymbol): string {
  return symbol[0]!.toUpperCase() + symbol.slice(1);
}

function symbolGraphic(symbol: CardSymbol): string {
  if (symbol === "rock") {
    return '<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M14 49 20 25 38 13 59 21 69 43 55 65 27 67Z"/><path class="detail" d="m20 26 18 14 21-18M38 40l-11 27m11-27 17 25"/></svg>';
  }
  if (symbol === "paper") {
    return '<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M20 9h29l13 14v48H20Z"/><path class="detail" d="M49 9v15h13M29 36h24M29 47h24M29 58h17"/></svg>';
  }
  return '<svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="24" cy="57" r="11"/><circle cx="51" cy="58" r="11"/><path d="m31 50 28-39M44 48 20 11"/><circle cx="38" cy="42" r="3"/></svg>';
}

function cardFace(symbol: CardSymbol, compact = false): string {
  return `
    <span class="card-corner">${symbol[0]!.toUpperCase()}</span>
    <span class="card-symbol ${symbol}">${symbolGraphic(symbol)}</span>
    ${compact ? "" : `<span class="card-name">${symbolLabel(symbol)}</span>`}
  `;
}

function cardBack(): string {
  return '<span class="back-mark"><i>R</i><i>P</i><i>S</i></span>';
}

function phaseLabel(phase: MatchSnapshot["phase"]): string {
  if (phase === "targeting") return "CHOOSE TARGET";
  if (phase === "preparation") return "PREPARE";
  if (phase === "battle") return "REVEAL";
  if (phase === "discard") return "RESHUFFLE";
  return "MATCH END";
}

class RpsClient {
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private snapshot: ServerSnapshot | null = null;
  private selectedCardId: string | null = null;
  private serverOffset = 0;
  private activeBattleSequence: { key: string; startedAt: number; timers: number[] } | null = null;
  private readonly completedBattleSequences = new Set<string>();
  private activeOutcomeSequence: { key: string; startedAt: number; timer: number } | null = null;
  private readonly completedOutcomeSequences = new Set<string>();
  private readonly firedBattleMoments = new Set<string>();
  private readonly animatedDrawCards = new Set<string>();
  private readonly revealedPairs = new Set<string>();
  private readonly drawTimers: number[] = [];
  private toastTimer: number | null = null;

  constructor() {
    this.socket = io({ transports: ["websocket", "polling"] });
    this.socket.on("connect", () => this.resumeOrRender());
    this.socket.on("disconnect", () => this.showToast("Connection lost. Reconnecting for up to 30 seconds…", true));
    this.socket.on("state:error", (message) => this.showToast(message, true));
    this.socket.on("state:snapshot", (snapshot) => {
      if (
        this.snapshot?.kind === "match" &&
        this.snapshot.phase === "finished" &&
        snapshot.kind === "match" &&
        snapshot.roomCode === this.snapshot.roomCode &&
        snapshot.phase === "targeting" &&
        snapshot.round === 1
      ) {
        this.completedBattleSequences.clear();
        this.clearOutcomeTimer();
        this.completedOutcomeSequences.clear();
        this.firedBattleMoments.clear();
        this.animatedDrawCards.clear();
        this.revealedPairs.clear();
      }
      this.snapshot = snapshot;
      if (snapshot.kind === "match") this.serverOffset = snapshot.serverNow - Date.now();
      this.render();
    });
    window.setInterval(() => this.updateClock(), 100);
  }

  private resumeOrRender(): void {
    const session = readSession();
    if (!session) {
      this.renderLanding();
      return;
    }
    this.socket.emit("room:resume", session, (result) => {
      if (!result.ok) {
        localStorage.removeItem(SESSION_KEY);
        this.snapshot = null;
        this.showToast(result.error, true);
        this.renderLanding();
      }
    });
  }

  private remember(receipt: SessionReceipt, name: string): void {
    localStorage.setItem(SESSION_KEY, JSON.stringify(receipt));
    localStorage.setItem(NAME_KEY, name);
  }

  private render(): void {
    if (!this.snapshot) {
      this.renderLanding();
      return;
    }
    if (this.snapshot.kind === "lobby") {
      this.renderWaitingRoom(this.snapshot);
      return;
    }
    this.renderMatch(this.snapshot);
  }

  private renderLanding(): void {
    const savedName = escapeHtml(localStorage.getItem(NAME_KEY) ?? "");
    app.innerHTML = `
      <main class="landing shell">
        <section class="brand-block">
          <h1><span>R</span><span>P</span><span>S</span></h1>
          <p class="tagline">Read the board. Hide the hand. Put your hearts where your nerve is.</p>
        </section>
        <section class="lobby-panel glass-panel">
          <label class="field-label" for="player-name">CALLSIGN</label>
          <input id="player-name" maxlength="18" autocomplete="nickname" value="${savedName}" placeholder="Player name" />
          <button class="primary wide" data-action="create">CREATE ROOM</button>
          <div class="join-row">
            <input id="room-code" maxlength="5" autocomplete="off" placeholder="ROOM CODE" />
            <button class="ghost" data-action="join">JOIN</button>
          </div>
          <button class="tutorial-launch" data-action="how-to">HOW TO PLAY</button>
        </section>
      </main>
      <footer class="landing-footer">ROCK BREAKS SCISSORS · SCISSORS CUT PAPER · PAPER COVERS ROCK</footer>
    `;
    app.querySelector<HTMLElement>("[data-action='create']")?.addEventListener("click", () => this.create());
    app.querySelector<HTMLElement>("[data-action='join']")?.addEventListener("click", () => this.join());
    app.querySelector<HTMLElement>("[data-action='how-to']")?.addEventListener("click", () => this.openTutorial());
    app.querySelector<HTMLInputElement>("#room-code")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      target.value = target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
  }

  private openTutorial(): void {
    const slides = [
      {
        eyebrow: "THE OBJECTIVE",
        title: "Outread the table.",
        copy: `
          <p>Every player begins with <strong>10 HP</strong> and draws three cards from the shared deck.</p>
          <ul><li>Rock breaks Scissors.</li><li>Scissors cut Paper.</li><li>Paper covers Rock.</li></ul>
          <p>Be the last player with HP, or reveal five identical cards after discarding.</p>`,
        visual: `<div class="tutorial-rps" aria-label="Rock beats Scissors, Scissors beat Paper, Paper beats Rock">
          ${(["rock", "paper", "scissors"] as const).map((symbol) => `<div class="tutorial-card face ${symbol}">${cardFace(symbol, true)}</div>`).join("")}
          <span class="tutorial-cycle">BEATS&nbsp; →</span>
        </div>`
      },
      {
        eyebrow: "1 · CHOOSE",
        title: "Pick your opponent.",
        copy: `
          <p>Attack turns move clockwise. When it is your turn, click any living opponent at the poker table.</p>
          <p>Everyone can see each player’s HP and hand size. With only two players left, the opponent is selected automatically.</p>`,
        visual: `<div class="tutorial-table" aria-hidden="true">
          <span class="tutorial-seat you">YOU<small>ATTACKER</small></span>
          <span class="tutorial-seat target">ARC-1<small>&hearts; 10</small></span>
          <span class="tutorial-seat waiting-seat">GTO-1<small>WAITING</small></span>
          <b>CHOOSE</b>
        </div>`
      },
      {
        eyebrow: "2 · COMMIT",
        title: "Cards first. Hearts second.",
        copy: `
          <p>Commit one face-down card and its HP for each pair, moving from left to right. Once committed, neither the card nor its HP can be taken back.</p>
          <p>The host chooses a 20-second, 30-second, or unlimited action timer. Locking without a card uses your leftmost card with 0 HP. A timed-out final pair still receives all remaining HP.</p>`,
        visual: `<div class="tutorial-lanes" aria-label="Commit three card pairs from left to right">
          ${[0, 1, 2].map((index) => `<div class="tutorial-lane ${index === 0 ? "active" : ""}"><small>${LANE_NAMES[index]}</small><div class="tutorial-card back">${cardBack()}</div><b>♥ ${index === 0 ? 3 : index === 1 ? "?" : "ALL"}</b></div>`).join("")}
        </div>`
      },
      {
        eyebrow: "3 · CLASH",
        title: "Reveal, then settle.",
        copy: `
          <p>Each committed pair reveals before the next pair begins. Once all three are ready, the clashes resolve from left to right.</p>
          <p>The winning card receives the loser’s HP minus one. Draws return both wagers. Playing three identical cards turns matching draws into wins for that player.</p>`,
        visual: `<div class="tutorial-clash" aria-label="Paper defeats Rock and receives four of five committed hearts">
          <div class="tutorial-card face rock">${cardFace("rock", true)}<b>♥ 5</b></div>
          <span><small>CLASH</small><strong>−1</strong></span>
          <div class="tutorial-card face paper">${cardFace("paper", true)}<b>♥ 2 → 6</b></div>
        </div>`
      },
      {
        eyebrow: "4 · RESHUFFLE",
        title: "Rebuild—or end it.",
        copy: `
          <p>Draw one card, then return the required cards to the shared deck. Lose no pairs to earn a bonus draw. You may also spend 1 HP for one extra draw and one extra discard.</p>
          <p>Your hand can hold at most five cards. Five matching cards after discard wins immediately. A player at 0 HP is eliminated.</p>`,
        visual: `<div class="tutorial-draw" aria-label="Draw from the shared deck toward a five-card hand">
          <div class="tutorial-deck">${cardBack()}<small>SHARED DECK</small></div><span>→</span>
          <div class="tutorial-five">${Array.from({ length: 5 }, (_, index) => `<i style="--card:${index}"></i>`).join("")}<b>FIVE OF A KIND</b></div>
        </div>`
      }
    ];

    const dialog = document.createElement("dialog");
    dialog.className = "tutorial-dialog";
    dialog.setAttribute("aria-labelledby", "tutorial-title");
    let slideIndex = 0;
    let touchStartX: number | null = null;

    const close = (): void => dialog.close();
    const show = (nextIndex: number): void => {
      slideIndex = Math.min(Math.max(nextIndex, 0), slides.length - 1);
      const slide = slides[slideIndex]!;
      dialog.innerHTML = `
        <article class="tutorial-shell">
          <header><span>${String(slideIndex + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}</span><button class="tutorial-close" type="button" aria-label="Close how to play">×</button></header>
          <div class="tutorial-content" aria-live="polite">
            <div class="tutorial-visual">${slide.visual}</div>
            <section class="tutorial-copy"><p class="eyebrow">${slide.eyebrow}</p><h2 id="tutorial-title">${slide.title}</h2>${slide.copy}</section>
          </div>
          <footer>
            <button class="ghost tutorial-back" type="button" ${slideIndex === 0 ? "disabled" : ""}>BACK</button>
            <nav aria-label="Tutorial slides">${slides.map((_, index) => `<button class="tutorial-dot ${index === slideIndex ? "active" : ""}" type="button" data-tutorial-slide="${index}" aria-label="Go to slide ${index + 1}" ${index === slideIndex ? 'aria-current="step"' : ""}></button>`).join("")}</nav>
            <button class="primary tutorial-next" type="button">${slideIndex === slides.length - 1 ? "GOT IT" : "NEXT"}</button>
          </footer>
        </article>`;
      dialog.querySelector<HTMLElement>(".tutorial-close")?.addEventListener("click", close);
      dialog.querySelector<HTMLElement>(".tutorial-back")?.addEventListener("click", () => show(slideIndex - 1));
      dialog.querySelector<HTMLElement>(".tutorial-next")?.addEventListener("click", () => {
        if (slideIndex === slides.length - 1) close();
        else show(slideIndex + 1);
      });
      dialog.querySelectorAll<HTMLElement>("[data-tutorial-slide]").forEach((button) => {
        button.addEventListener("click", () => show(Number(button.dataset.tutorialSlide)));
      });
    };

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") show(slideIndex + 1);
      if (event.key === "ArrowLeft") show(slideIndex - 1);
    });
    dialog.addEventListener("touchstart", (event) => {
      touchStartX = event.changedTouches[0]?.clientX ?? null;
    }, { passive: true });
    dialog.addEventListener("touchend", (event) => {
      if (touchStartX === null) return;
      const distance = (event.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
      if (Math.abs(distance) > 55) show(slideIndex + (distance < 0 ? 1 : -1));
      touchStartX = null;
    }, { passive: true });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    show(0);
    dialog.showModal();
  }

  private playerName(): string {
    return app.querySelector<HTMLInputElement>("#player-name")?.value.trim() ?? "";
  }

  private create(): void {
    const name = this.playerName();
    this.socket.emit("room:create", { name }, (result) => {
      this.handleReceipt(result, name);
    });
  }

  private join(): void {
    const name = this.playerName();
    const roomCode = app.querySelector<HTMLInputElement>("#room-code")?.value ?? "";
    this.socket.emit("room:join", { name, roomCode }, (result) => {
      this.handleReceipt(result, name);
    });
  }

  private handleReceipt(result: Ack<SessionReceipt>, name: string): void {
    if (!result.ok) {
      this.showToast(result.error, true);
      return;
    }
    this.remember(result.data, name);
  }

  private renderWaitingRoom(view: LobbySnapshot): void {
    const isHost = view.selfPlayerId === view.hostPlayerId;
    const seats = Array.from({ length: view.maximumSeats }, (_, seatIndex) => {
      const player = view.players.find((candidate) => candidate.seatIndex === seatIndex);
      if (!player) {
        return `<li class="lobby-seat empty-seat"><span>${seatIndex + 1}</span><div><strong>OPEN SEAT</strong></div></li>`;
      }
      return `
        <li class="lobby-seat ${player.id === view.hostPlayerId ? "host-seat" : ""}">
          <span>${seatIndex + 1}</span>
          <i class="connection ${player.connected ? "online" : "offline"}"></i>
          <div>
            <strong>${escapeHtml(player.name)}${player.id === view.selfPlayerId ? " · YOU" : ""}</strong>
            <small>${player.id === view.hostPlayerId ? "HOST" : player.isBot ? player.botDifficulty === "advanced" ? "GTO COMPUTER" : player.botDifficulty === "learned" ? "LEARNED COMPUTER" : "BASIC COMPUTER" : player.connected ? "PLAYER" : "RECONNECTING"}</small>
          </div>
          ${isHost && player.isBot ? `<button class="seat-remove" data-remove-bot="${player.id}" title="Remove computer">×</button>` : ""}
        </li>`;
    }).join("");
    app.innerHTML = `
      <main class="waiting shell">
        <section class="glass-panel waiting-card group-lobby">
          <div class="lobby-heading">
            <h2 class="room-ready-title">ROOM READY</h2>
            <div><small>ROOM CODE</small><button class="room-code" data-action="copy" aria-label="Copy room code">${escapeHtml(view.roomCode)}</button></div>
          </div>
          <section class="lobby-timer" aria-label="Action timer">
            <strong>ACTION TIMER</strong>
            ${isHost ? `<div class="timer-dropdown" data-timer-dropdown>
              <button type="button" class="timer-select-trigger" data-action="toggle-timer" aria-haspopup="listbox" aria-expanded="false">
                <span>${view.actionTimeMs === null ? "NO LIMIT" : `${view.actionTimeMs / 1_000} SEC`}</span><i aria-hidden="true"></i>
              </button>
              <div class="timer-select-menu" role="listbox" aria-label="Choose action timer">
                <button type="button" role="option" aria-selected="${view.actionTimeMs === 20_000}" class="${view.actionTimeMs === 20_000 ? "active" : ""}" data-action-time="20000">20 SEC</button>
                <button type="button" role="option" aria-selected="${view.actionTimeMs === 30_000}" class="${view.actionTimeMs === 30_000 ? "active" : ""}" data-action-time="30000">30 SEC</button>
                <button type="button" role="option" aria-selected="${view.actionTimeMs === null}" class="${view.actionTimeMs === null ? "active" : ""}" data-action-time="none">NO LIMIT</button>
              </div>
            </div>` : `<b>${view.actionTimeMs === null ? "NO LIMIT" : `${view.actionTimeMs / 1_000} SEC`}</b>`}
          </section>
          <ol class="lobby-seats">${seats}</ol>
          <div class="lobby-actions">
            ${isHost ? `
              <button class="secondary" data-action="add-basic-bot" ${view.players.length >= view.maximumSeats ? "disabled" : ""}>ADD BASIC BOT</button>
              <button class="secondary advanced-bot-button" data-action="add-advanced-bot" ${view.players.length >= view.maximumSeats ? "disabled" : ""}>ADD ADVANCED BOT</button>
              <button class="secondary learned-bot-button" data-action="add-learned-bot" ${view.players.length >= view.maximumSeats ? "disabled" : ""}>ADD LEARNED BOT</button>
              <button class="primary" data-action="start" ${view.players.length < 2 ? "disabled" : ""}>START · ${view.players.length} SEATS</button>
            ` : '<p class="waiting-pulse"><i></i> Host is arranging the table</p>'}
            <button class="text-button" data-action="leave">Leave room</button>
          </div>
        </section>
      </main>
    `;
    app.querySelector<HTMLElement>("[data-action='copy']")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(view.roomCode);
      this.showToast("Room code copied.");
    });
    app.querySelector<HTMLElement>("[data-action='add-basic-bot']")?.addEventListener("click", () => this.socket.emit("room:add-bot", { difficulty: "basic" }));
    app.querySelector<HTMLElement>("[data-action='add-advanced-bot']")?.addEventListener("click", () => this.socket.emit("room:add-bot", { difficulty: "advanced" }));
    app.querySelector<HTMLElement>("[data-action='add-learned-bot']")?.addEventListener("click", () => this.socket.emit("room:add-bot", { difficulty: "learned" }));
    const timerDropdown = app.querySelector<HTMLElement>("[data-timer-dropdown]");
    const timerTrigger = timerDropdown?.querySelector<HTMLButtonElement>("[data-action='toggle-timer']");
    timerTrigger?.addEventListener("click", () => {
      const isOpen = timerDropdown!.classList.toggle("open");
      timerTrigger.setAttribute("aria-expanded", String(isOpen));
    });
    timerDropdown?.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!timerDropdown.contains(document.activeElement)) {
          timerDropdown.classList.remove("open");
          timerTrigger?.setAttribute("aria-expanded", "false");
        }
      });
    });
    timerDropdown?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      timerDropdown.classList.remove("open");
      timerTrigger?.setAttribute("aria-expanded", "false");
      timerTrigger?.focus();
    });
    app.querySelectorAll<HTMLButtonElement>("[data-action-time]").forEach((option) => {
      option.addEventListener("click", () => {
        const actionTimeMs = option.dataset.actionTime === "none" ? null : Number(option.dataset.actionTime) as 20_000 | 30_000;
        timerDropdown?.classList.remove("open");
        timerTrigger?.setAttribute("aria-expanded", "false");
        this.socket.emit("room:set-action-time", { actionTimeMs });
      });
    });
    app.querySelector<HTMLElement>("[data-action='start']")?.addEventListener("click", () => this.socket.emit("room:start"));
    app.querySelectorAll<HTMLElement>("[data-remove-bot]").forEach((button) => {
      button.addEventListener("click", () => this.socket.emit("room:remove-bot", { playerId: button.dataset.removeBot! }));
    });
    app.querySelector<HTMLElement>("[data-action='leave']")?.addEventListener("click", () => this.leave());
  }

  private renderMatch(view: MatchSnapshot): void {
    const self = view.players.find((player) => player.id === view.selfPlayerId)!;
    const attacker = view.players.find((player) => player.id === view.attackerId)!;
    const defender = view.defenderId
      ? view.players.find((player) => player.id === view.defenderId) ?? null
      : null;
    const selfIsDuelist = self.id === attacker.id || self.id === defender?.id;
    const bottom = selfIsDuelist ? self : attacker;
    const opponent = defender
      ? (bottom.id === attacker.id ? defender : attacker)
      : view.players.find((player) => !player.eliminated && player.id !== attacker.id) ?? attacker;
    const sequencePending = this.shouldAnimateBattle(view);
    const outcomeSequencePending = view.phase === "finished"
      && !sequencePending
      && view.outcome !== null
      && !this.completedOutcomeSequences.has(this.outcomeKey(view));
    const displayBottomHp = sequencePending ? this.hpBeforeBattle(view, bottom.id) : bottom.hp;
    const unassigned = view.phase === "preparation" && selfIsDuelist
      ? self.hp - self.slots.reduce((total, slot) => total + slot.hearts, 0)
      : 0;
    const body = view.phase === "finished" && !sequencePending
      ? this.finalTable(view)
      : view.phase === "targeting"
        ? this.targetTable(view, self, attacker)
        : view.phase === "discard"
          ? selfIsDuelist
            ? this.discardPanel(view, self, opponent)
            : this.spectatorPanel(view, attacker, defender)
          : this.battleBoard(view, self, bottom, opponent, unassigned, displayBottomHp, sequencePending);

    app.innerHTML = `
      <main class="match-shell">
        <header class="match-header">
          <div class="identity self-id" aria-label="Your player information">
            <strong>${escapeHtml(self.name)}</strong>
            <span class="header-private-hand" aria-label="Your cards">${view.self.hand.map((card) => `<i class="header-card-symbol ${card.symbol}" title="${symbolLabel(card.symbol)}">${symbolGraphic(card.symbol)}</i>`).join("")}</span>
            <span class="total-hp">♥ ${self.hp}</span>
          </div>
          <div class="round-clock">
            <small>ROUND ${view.round}</small>
            <strong>${sequencePending ? "REVEAL" : view.phase === "targeting" && view.defenderId ? "DUEL SELECTED" : view.phase === "preparation" ? `${LANE_NAMES[view.activeLane]} PAIR` : phaseLabel(view.phase)}</strong>
            <span id="phase-clock">--:--</span>
          </div>
          <div class="header-actions">
            <span class="deck-count">DECK ${view.deckCount}</span>
            <button class="icon-button" data-action="leave" title="Leave match">×</button>
          </div>
        </header>
        ${body}
      </main>
      ${view.phase === "finished" && !sequencePending && !outcomeSequencePending ? this.resultOverlay(view, self) : ""}
    `;

    this.bindMatch(view, self, selfIsDuelist);
    this.updateClock();
    this.startPairReveal(view);
    this.startBattleSequence(view);
    this.startDrawSequence(view);
    this.startOutcomeSequence(view, self, sequencePending);
  }

  private pokerPositions(view: MatchSnapshot): PokerPosition[] {
    const selfIndex = view.players.findIndex((player) => player.id === view.selfPlayerId);
    const seatCount = view.players.length;
    return view.players.map((player, index) => {
      const relativeIndex = (index - selfIndex + seatCount) % seatCount;
      const angle = Math.PI / 2 - relativeIndex * (Math.PI * 2 / seatCount);
      return { playerId: player.id, x: 50 + Math.cos(angle) * 44, y: 50 + Math.sin(angle) * 44 };
    });
  }

  private targetTable(view: MatchSnapshot, self: PublicPlayerView, attacker: PublicPlayerView): string {
    const livingCount = view.players.filter((player) => !player.eliminated).length;
    const defender = view.defenderId ? view.players.find((player) => player.id === view.defenderId) ?? null : null;
    const introActive = defender !== null;
    const choosing = !introActive && self.id === attacker.id && !self.eliminated;
    const positions = this.pokerPositions(view);
    const seats = view.players.map((player, index) => {
      const isAttacker = player.id === view.attackerId;
      const isDefender = player.id === view.defenderId;
      const isTarget = choosing && !player.eliminated && !isAttacker;
      const { x, y } = positions[index]!;
      const stateLabel = player.eliminated
        ? "OUT"
        : isAttacker
          ? introActive ? "ATTACKER" : ""
          : isDefender
            ? "DEFENDER"
          : isTarget
            ? ""
            : player.connected
              ? "WAITING"
              : "RECONNECTING";
      const tag = isTarget ? "button" : "article";
      return `
        <${tag} ${isTarget ? `type="button" data-target-player="${player.id}"` : ""} class="poker-seat ${player.eliminated ? "eliminated" : ""} ${isAttacker ? "attacker" : ""} ${isAttacker && !introActive ? "choosing" : ""} ${isDefender ? "defender" : ""} ${isTarget ? "targetable" : ""}" style="--seat-x:${x.toFixed(2)}%;--seat-y:${y.toFixed(2)}%">
          <span class="seat-number">${player.seatIndex + 1}</span>
          <div class="poker-seat-copy">
            <span class="poker-name-line"><strong>${escapeHtml(player.name)}${player.id === view.selfPlayerId ? " · YOU" : ""}</strong><span class="poker-card-source" data-card-source-player="${player.id}">${this.cardCountDisplay(player.handCount, "stack")}</span></span>
            ${stateLabel ? `<small>${stateLabel}</small>` : ""}
          </div>
          <b>&hearts; ${player.hp}</b>
        </${tag}>`;
    }).join("");
    const attackerPosition = positions.find((position) => position.playerId === attacker.id)!;
    const defenderPosition = defender ? positions.find((position) => position.playerId === defender.id)! : null;
    const introElapsed = introActive && view.deadlineAt !== null
      ? Math.min(Math.max(2_000 - (view.deadlineAt - view.serverNow), 0), 2_000)
      : 0;
    const punch = defender && defenderPosition ? `
      <div class="versus-punch" aria-label="${escapeHtml(attacker.name)} challenges ${escapeHtml(defender.name)}"
        style="--from-x:${attackerPosition.x.toFixed(2)}%;--from-y:${attackerPosition.y.toFixed(2)}%;--to-x:${defenderPosition.x.toFixed(2)}%;--to-y:${defenderPosition.y.toFixed(2)}%;--intro-delay:-${introElapsed}ms">
        <span>VS</span><i></i>
      </div>` : "";
    return `
      <section class="poker-roster targeting-roster" aria-label="Choose an opponent from the poker table">
        <div class="poker-felt targeting-felt ${introActive ? "duel-intro" : choosing ? "choosing-active" : "waiting-choice"}">
          <div class="poker-center target-table-copy">
            <small>SEAT ${attacker.seatIndex + 1} · ${livingCount} PLAYERS LEFT</small>
            <h2>${introActive ? `${escapeHtml(attacker.name)} vs ${escapeHtml(defender!.name)}` : choosing ? "Choose opponent" : `${escapeHtml(attacker.name)} is choosing`}</h2>
            <p>${introActive ? "Challenge locked. Prepare for the first pair." : choosing ? "Click any living opponent at the table." : "Waiting for the highlighted player."}</p>
            ${introActive ? "" : '<span class="choosing-dots" aria-hidden="true"><i></i><i></i><i></i></span>'}
          </div>
          ${seats}
          ${punch}
        </div>
        ${self.eliminated ? '<p class="spectator-note">You are eliminated, but you can watch the match to the end.</p>' : ""}
      </section>`;
  }

  private finalTable(view: MatchSnapshot): string {
    const outcome = view.outcome!;
    const positions = this.pokerPositions(view);
    const sequenceKey = this.outcomeKey(view);
    const sequenceElapsed = this.activeOutcomeSequence?.key === sequenceKey
      ? performance.now() - this.activeOutcomeSequence.startedAt
      : 0;
    const crownedIds = outcome.kind === "winner" && outcome.winnerId
      ? [outcome.winnerId]
      : view.battle
        ? [...view.battle.duelistIds]
        : view.players.slice(-2).map((player) => player.id);
    const crownDelay = this.outcomeCrownDelay(view) - sequenceElapsed;
    const seats = view.players.map((player, index) => {
      const { x, y } = positions[index]!;
      const crowned = crownedIds.includes(player.id);
      const label = crowned
        ? outcome.kind === "draw" ? "DRAW" : "WINNER"
        : player.eliminated ? "OUT" : "FINALIST";
      return `
        <article class="poker-seat outcome-seat ${crowned ? "crowned-seat" : ""}" style="--seat-x:${x.toFixed(2)}%;--seat-y:${y.toFixed(2)}%;--crown-delay:${crownDelay}ms">
          <span class="seat-number">${player.seatIndex + 1}</span>
          <div class="poker-seat-copy">
            <span class="poker-name-line"><strong>${escapeHtml(player.name)}${player.id === view.selfPlayerId ? " · YOU" : ""}</strong><span class="poker-card-source" data-card-source-player="${player.id}">${this.cardCountDisplay(player.handCount, "stack")}</span></span>
            <small>${label}</small>
          </div>
          <b>&hearts; ${player.hp}</b>
        </article>`;
    }).join("");
    const crowns = crownedIds.map((playerId) => {
      const position = positions.find((item) => item.playerId === playerId);
      if (!position) return "";
      const name = view.players.find((player) => player.id === playerId)?.name ?? "winner";
      return `
        <span class="winner-crown" aria-label="Crown for ${escapeHtml(name)}" style="--crown-x:${position.x.toFixed(2)}%;--crown-y:${position.y.toFixed(2)}%;--crown-rest:${position.y < 18 ? 30 : -42}px;--crown-delay:${crownDelay}ms">
          <svg viewBox="0 0 96 72" aria-hidden="true"><path d="M10 21 31 42 48 11 65 42 86 21 78 61H18Z"/><path class="crown-band" d="M18 53h60v13H18Z"/><circle cx="10" cy="19" r="5"/><circle cx="48" cy="9" r="5"/><circle cx="86" cy="19" r="5"/></svg>
        </span>`;
    }).join("");
    const centerTitle = outcome.reason === "showdown"
      ? outcome.kind === "draw" ? "Five meet five" : "Five of a kind"
      : outcome.kind === "draw" ? "Final draw" : "A champion remains";
    return `
      <section class="poker-roster outcome-roster" aria-label="Final table">
        <div class="poker-felt outcome-felt">
          <div class="poker-center outcome-table-copy">
            <small>MATCH COMPLETE</small>
            <h2>${centerTitle}</h2>
          </div>
          ${seats}
          ${this.showdownCards(view, positions, sequenceElapsed)}
          ${crowns}
        </div>
      </section>`;
  }

  private showdownCards(view: MatchSnapshot, positions: PokerPosition[], sequenceElapsed: number): string {
    if (view.outcome?.reason !== "showdown" || !view.outcome.showdownSymbols || !view.battle) return "";
    const entries = view.outcome.showdownSymbols.flatMap((symbol, index) => {
      const playerId = view.battle!.duelistIds[index];
      return symbol ? [{ playerId, symbol }] : [];
    });
    const ordered = view.outcome.kind === "winner" && entries.length === 2
      ? [...entries].sort((entry) => entry.playerId === view.outcome!.winnerId ? 1 : -1)
      : entries;
    return ordered.map((entry, batchIndex) => {
      const origin = positions.find((position) => position.playerId === entry.playerId);
      if (!origin) return "";
      const isWinner = entry.playerId === view.outcome!.winnerId;
      const batchDelay = view.outcome!.kind === "winner" && ordered.length === 2
        ? batchIndex * 1_550
        : 0;
      const rowY = view.outcome!.kind === "draw" && ordered.length === 2
        ? batchIndex === 0 ? 43 : 59
        : 52;
      return Array.from({ length: 5 }, (_, cardIndex) => {
        const targetX = 50 + (cardIndex - 2) * 15.5;
        const delay = 120 + batchDelay + cardIndex * 130 - sequenceElapsed;
        return `
          <span class="showdown-card face ${entry.symbol} ${isWinner ? "showdown-winner" : "showdown-challenger"}" data-showdown-player="${entry.playerId}" style="--card-from-x:${origin.x.toFixed(2)}%;--card-from-y:${origin.y.toFixed(2)}%;--card-to-x:${targetX.toFixed(2)}%;--card-to-y:${rowY}%;--showdown-delay:${delay}ms;--showdown-layer:${isWinner ? 9 : 7}">
            ${cardFace(entry.symbol, true)}
          </span>`;
      }).join("");
    }).join("");
  }

  private cardCountDisplay(count: number, mode: "stack" | "individual"): string {
    const iconCount = mode === "stack" ? Math.min(count, 1) : count;
    return `<span class="card-count-display" aria-label="${count} cards left"><span class="card-count-icons" aria-hidden="true">${Array.from(
      { length: iconCount },
      () => "<i></i>"
    ).join("")}</span>${mode === "stack" ? `<b>&times;${count}</b>` : count === 0 ? "<b>0</b>" : ""}</span>`;
  }

  private duelistBox(
    view: MatchSnapshot,
    player: PublicPlayerView,
    shownHp: number,
    side: "top" | "bottom"
  ): string {
    const role = player.id === view.attackerId ? "ATTACKER" : "DEFENDER";
    const cardsLeft = Math.max(player.handCount - player.slots.filter((slot) => slot.occupied).length, 0);
    return `
      <section class="duelist-box ${side}-duelist" aria-label="${side} duelist ${escapeHtml(player.name)}" data-duelist-total-player="${player.id}">
        <span class="duelist-role">${side.toUpperCase()} · ${role}</span>
        <strong>${escapeHtml(player.name)}${player.isBot ? player.botDifficulty === "advanced" ? " // GTO" : player.botDifficulty === "learned" ? " // RL" : " // CPU" : ""}</strong>
        ${this.cardCountDisplay(cardsLeft, "individual")}
        <b class="duelist-hp">&hearts; ${shownHp}</b>
      </section>`;
  }

  private spectatorPanel(
    view: MatchSnapshot,
    attacker: PublicPlayerView,
    defender: PublicPlayerView | null
  ): string {
    return `
      <section class="target-stage spectator-stage">
        <p class="eyebrow">SHUFFLE PHASE</p>
        <h2>${escapeHtml(attacker.name)} and ${escapeHtml(defender?.name ?? "their opponent")} are rebuilding their hands.</h2>
        <p>Your cards stay in your hand. The next living seat clockwise attacks after both duelists lock their discards.</p>
        <div class="spectator-hand hand-row">${view.self.hand.map((card) => `<span class="hand-card face ${card.symbol}">${cardFace(card.symbol)}</span>`).join("")}</div>
      </section>`;
  }

  private battleBoard(
    view: MatchSnapshot,
    self: PublicPlayerView,
    bottom: PublicPlayerView,
    opponent: PublicPlayerView,
    unassigned: number,
    displayBottomHp: number,
    sequencePending: boolean
  ): string {
    const selfIsDuelist = self.id === bottom.id;
    const collectionComplete = Boolean(
      view.battle && this.completedBattleSequences.has(`${view.roomCode}:${view.battle.round}`)
    );
    const lanes = [0, 1, 2].map((index) => {
      const opponentBattle = view.battle?.lanes[index]?.sides.find((side) => side.playerId === opponent.id);
      const selfBattle = view.battle?.lanes[index]?.sides.find((side) => side.playerId === bottom.id);
      const pairState = view.phase === "preparation"
        ? index < view.activeLane
          ? "pair-revealed"
          : index === view.activeLane
            ? "pair-active"
            : "pair-waiting"
        : "";
      const emptyLabel = view.phase !== "preparation"
        ? "EMPTY"
        : index < view.activeLane
          ? "EMPTY"
          : index === view.activeLane
            ? "DROP CARD"
            : "WAITING";
      return `
        <section class="battle-lane ${pairState} ${sequencePending && view.battle ? "lane-revealing" : ""} ${selfBattle && !sequencePending ? `result-${selfBattle.result} lane-resolved` : ""}" data-slot="${index}" data-result="${selfBattle?.result ?? ""}">
          ${view.phase === "preparation" ? `<span class="pair-phase-label">${index === view.activeLane ? "CURRENT PAIR" : ""}</span>` : ""}
          <div class="slot opponent-slot">
            ${this.boardCard(
              opponent.slots[index]!,
              opponentBattle?.symbol ?? opponent.slots[index]!.symbol,
              false,
              view.phase,
              emptyLabel
            )}
            <span class="heart-badge" data-lane-heart="opponent">♥ ${collectionComplete ? 0 : opponentBattle?.hearts ?? opponent.slots[index]!.hearts}</span>
            ${opponent.locked && view.phase === "preparation" && index === view.activeLane ? '<span class="lock-seal">LOCKED</span>' : ""}
          </div>
          <div class="versus-line">
            <span></span><b>${selfBattle && !sequencePending ? selfBattle.result.toUpperCase() : "VS"}</b><span></span>
            ${view.battle?.lanes[index]?.tripleOverride ? '<em>TRIPLE OVERRIDE</em>' : ""}
          </div>
          <div class="slot self-slot" data-drop-slot="${index}">
            ${this.boardCard(bottom.slots[index]!, selfBattle?.symbol ?? bottom.slots[index]!.symbol, true, view.phase, emptyLabel)}
            <span class="heart-badge own" data-lane-heart="self">♥ ${collectionComplete ? 0 : selfBattle?.hearts ?? bottom.slots[index]!.hearts}</span>
          </div>
          ${view.phase === "preparation" && selfIsDuelist && !self.locked && index === view.activeLane ? `
            ${view.activeLane < 2 ? `<div class="heart-controls">
              <button data-heart="1" data-index="${index}" ${!self.slots[index]!.occupied || unassigned <= 0 ? "disabled" : ""}>+1</button>
              <button data-heart="${unassigned}" data-heart-mode="all" data-index="${index}" ${!self.slots[index]!.occupied || unassigned <= 0 ? "disabled" : ""}>ALL</button>
            </div>` : self.slots[index]!.occupied ? '<span class="forced-allocation">ALL REMAINING HP</span>' : ""}
          ` : ""}
        </section>
      `;
    }).join("");
    const displayOpponentHp = sequencePending ? this.hpBeforeBattle(view, opponent.id) : opponent.hp;

    return `
      ${this.duelistBox(view, opponent, displayOpponentHp, "top")}
      <section class="battle-grid ${sequencePending ? "battle-sequence cards-pre-revealed" : ""}">${lanes}</section>
      ${this.duelistBox(view, bottom, displayBottomHp, "bottom")}
      <section class="player-console">
        ${selfIsDuelist && view.phase === "preparation" ? `<div class="self-summary"><span class="unassigned ${view.activeLane === 2 && !self.slots[2].occupied ? "danger" : "safe"}"><small>HP LEFT</small><strong>♥ ${unassigned}</strong></span></div>` : !selfIsDuelist ? '<div class="self-summary"><span><small>YOU ARE WATCHING</small><strong class="spectating-label">SPECTATOR</strong></span></div>' : ""}
        <div class="hand-row">${view.self.hand.map((card) => this.handCard(card, self, view)).join("")}</div>
        ${view.phase === "preparation" && selfIsDuelist ? `
          <div class="phase-actions">
            <p>${self.locked
              ? `Pair ${view.activeLane + 1} locked. Waiting for opponent.`
              : view.activeLane < 2
                ? self.slots[view.activeLane].occupied
                  ? `${unassigned} HP remains available for later pairs.`
                  : "Lock now to commit your leftmost card with 0 HP."
                : self.slots[2].occupied
                  ? `The final card automatically carries all ${self.slots[2].hearts} remaining HP.`
                  : `Lock now to commit your leftmost card with 0 HP and lose ${unassigned} unassigned HP.`}</p>
            <button class="primary lock-button" data-action="lock" ${self.locked ? "disabled" : ""}>${self.locked ? "LOCKED" : `LOCK PAIR ${view.activeLane + 1}`}</button>
          </div>
        ` : view.phase === "preparation" ? `<p class="reveal-message">${escapeHtml(bottom.name)} and ${escapeHtml(opponent.name)} are committing pair ${view.activeLane + 1}.</p>` : view.phase === "battle" || sequencePending || view.phase === "finished" ? '<p class="reveal-message">Cards revealed. Resolving lanes, then collecting every card\'s hearts…</p>' : ""}
      </section>
    `;
  }

  private boardCard(
    slot: PublicPlayerView["slots"][number],
    revealedSymbol: CardSymbol | null,
    own: boolean,
    phase: MatchSnapshot["phase"],
    emptyLabel = "DROP CARD"
  ): string {
    if (revealedSymbol) {
      return `<div class="board-card face ${own ? "owned" : "revealed"}">${cardFace(revealedSymbol)}</div>`;
    }
    if (!slot.occupied) {
      const helper = emptyLabel === "WAITING"
        ? `PAIR ${phase === "preparation" ? "PENDING" : ""}`
        : emptyLabel === "DROP CARD"
          ? "TIMEOUT: LEFTMOST"
          : "AUTO-LOSS";
      return `<div class="board-card empty"><span>${emptyLabel}</span><small>${helper}</small></div>`;
    }
    return `<div class="board-card back">${cardBack()}</div>`;
  }

  private handCard(card: Card, self: PublicPlayerView, view: MatchSnapshot): string {
    const selectedForDiscard = view.self.discardSelection.includes(card.id);
    const selected = this.selectedCardId === card.id;
    const placedIndex = view.self.slotCardIds.indexOf(card.id);
    const isDuelist = self.id === view.attackerId || self.id === view.defenderId;
    const committed = view.phase === "preparation" && placedIndex >= 0;
    const canPrepare = view.phase === "preparation" && isDuelist && !self.locked && !committed;
    const canDiscard = view.phase === "discard" && isDuelist && !self.locked;
    const drawPending = view.phase === "discard"
      && view.self.drawnCardIds.includes(card.id)
      && !this.animatedDrawCards.has(this.drawCardKey(view, card.id));
    return `
      <button class="hand-card face ${card.symbol} ${selected ? "selected" : ""} ${selectedForDiscard ? "discard-selected" : ""} ${drawPending ? "draw-pending" : ""} ${committed ? "committed" : ""}"
        data-card-id="${card.id}" draggable="${canPrepare}" ${canPrepare || canDiscard ? "" : "disabled"}>
        ${cardFace(card.symbol)}
        ${committed ? `<span class="commit-mark">PAIR ${placedIndex + 1}</span>` : ""}
        ${selectedForDiscard ? '<span class="discard-mark">DISCARD</span>' : ""}
      </button>
    `;
  }

  private discardPanel(view: MatchSnapshot, self: PublicPlayerView, opponent: PublicPlayerView): string {
    const selected = view.self.discardSelection.length;
    const canBuyDraw = !self.locked
      && !view.self.extraDrawPurchased
      && self.hp > 1
      && view.deckCount > 0;
    const buyLabel = view.self.extraDrawPurchased
      ? "EXTRA DRAW BOUGHT"
      : self.hp <= 1
        ? "EXTRA DRAW REQUIRES 2 HP"
        : view.deckCount <= 0
          ? "DECK EMPTY"
          : "SPEND ♥1 · DRAW +1";
    return `
      <section class="discard-stage">
        <div class="discard-copy">
          <p class="eyebrow">THE DECK TAKES BACK</p>
          <h2>${view.self.noLossBonus ? "No losses. Bonus draw earned." : "Choose what returns to chance."}</h2>
          <p>Select ${view.self.requiredDiscards} card${view.self.requiredDiscards === 1 ? "" : "s"}. Identities remain hidden from ${escapeHtml(opponent.name)}.</p>
          <span class="discard-hp" data-total-player="${self.id}"><small>YOUR HP</small><strong>♥ ${self.hp}</strong></span>
        </div>
        <div class="discard-hand hand-row">
          ${view.self.hand.map((card) => this.handCard(card, self, view)).join("")}
        </div>
        <button class="secondary buy-draw" data-action="buy-draw" ${canBuyDraw ? "" : "disabled"}>
          <span>${buyLabel}</span><small>Also discard one additional card</small>
        </button>
        <div class="phase-actions discard-actions">
          <p>${self.locked ? "Discard locked. Waiting for opponent." : `${selected} / ${view.self.requiredDiscards} selected`}</p>
          <button class="primary lock-button" data-action="lock" ${self.locked || selected !== view.self.requiredDiscards ? "disabled" : ""}>
            ${self.locked ? "LOCKED" : "LOCK DISCARD"}
          </button>
        </div>
        <div class="opponent-discard-status">
          <span class="connection ${opponent.connected ? "online" : "offline"}"></span>
          ${opponent.locked ? "Opponent locked" : "Opponent is choosing"}
        </div>
      </section>
    `;
  }

  private resultOverlay(view: MatchSnapshot, self: PublicPlayerView): string {
    const won = view.outcome?.winnerId === self.id;
    const draw = view.outcome?.kind === "draw";
    const winner = view.players.find((player) => player.id === view.outcome?.winnerId);
    const title = draw ? "DRAW" : won ? "VICTORY" : "DEFEAT";
    const detail = view.outcome?.reason === "showdown"
      ? "Five of a kind decided the table."
      : view.outcome?.reason === "forfeit"
        ? "A disconnect passed the match."
        : draw
          ? "No player remains with any HP."
          : won
            ? "You are the last player standing."
            : `${escapeHtml(winner?.name ?? "Another player")} is the last player standing.`;
    return `
      <div class="result-scrim">
        <section class="result-card ${draw ? "draw" : won ? "win" : "loss"}">
          <p class="eyebrow">MATCH COMPLETE</p>
          <h2>${title}</h2>
          <p>${detail}</p>
          <div class="result-actions">
            <button class="primary" data-action="rematch" ${self.rematchRequested ? "disabled" : ""}>${self.rematchRequested ? "REMATCH REQUESTED" : "REQUEST REMATCH"}</button>
            <button class="ghost" data-action="leave">LEAVE TABLE</button>
          </div>
        </section>
      </div>
    `;
  }

  private bindMatch(
    view: MatchSnapshot,
    self: PublicPlayerView,
    selfIsDuelist: boolean
  ): void {
    app.querySelectorAll<HTMLElement>("[data-target-player]").forEach((button) => {
      button.addEventListener("click", () => this.socket.emit("match:target", { playerId: button.dataset.targetPlayer! }));
    });
    app.querySelectorAll<HTMLElement>("[data-card-id]").forEach((element) => {
      element.addEventListener("click", () => {
        const cardId = element.dataset.cardId!;
        if (view.phase === "discard" && selfIsDuelist && !self.locked) {
          const alreadySelected = view.self.discardSelection.includes(cardId);
          const next = alreadySelected
            ? view.self.discardSelection.filter((id) => id !== cardId)
            : [...view.self.discardSelection, cardId];
          if (next.length <= view.self.requiredDiscards) {
            if (!alreadySelected) {
              gameAudio.playDiscard();
              this.animateDiscardToDeck(element);
            }
            this.socket.emit("match:discard", { cardIds: next });
          }
          return;
        }
        if (view.phase === "preparation" && selfIsDuelist && !self.locked && !view.self.slotCardIds.includes(cardId)) {
          this.selectedCardId = this.selectedCardId === cardId ? null : cardId;
          this.render();
        }
      });
      element.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/card-id", element.dataset.cardId!);
      });
    });

    app.querySelectorAll<HTMLElement>("[data-drop-slot]").forEach((element) => {
      element.addEventListener("dragover", (event) => event.preventDefault());
      element.addEventListener("drop", (event) => {
        event.preventDefault();
        if (Number(element.dataset.dropSlot) !== view.activeLane) return;
        const cardId = event.dataTransfer?.getData("text/card-id");
        if (cardId) {
          gameAudio.playCardPlace();
          this.socket.emit("match:place", { slotIndex: Number(element.dataset.dropSlot), cardId });
        }
      });
      element.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button")) return;
         if (
           view.phase === "preparation"
           && selfIsDuelist
           && !self.locked
          && Number(element.dataset.dropSlot) === view.activeLane
          && this.selectedCardId
        ) {
          this.socket.emit("match:place", {
            slotIndex: Number(element.dataset.dropSlot),
            cardId: this.selectedCardId
          });
          gameAudio.playCardPlace();
          this.selectedCardId = null;
        }
      });
    });

    app.querySelectorAll<HTMLButtonElement>("[data-heart]").forEach((button) => {
      button.addEventListener("click", () => {
        const delta = Number(button.dataset.heart);
        const commit = (): void => {
          button.disabled = true;
          this.socket.emit("match:hearts", {
            slotIndex: Number(button.dataset.index),
            delta
          });
        };
        if (button.dataset.heartMode === "all") this.confirmAllHearts(delta, commit);
        else commit();
      });
    });
    app.querySelectorAll<HTMLElement>("[data-action='lock']").forEach((button) => {
      button.addEventListener("click", () => {
        gameAudio.playLock();
        this.socket.emit("match:lock");
      });
    });
    app.querySelectorAll<HTMLElement>("[data-action='leave']").forEach((button) => {
      button.addEventListener("click", () => this.leave());
    });
    app.querySelector<HTMLElement>("[data-action='rematch']")?.addEventListener("click", () => {
      this.socket.emit("room:rematch");
    });
    app.querySelector<HTMLElement>("[data-action='buy-draw']")?.addEventListener("click", () => {
      this.socket.emit("match:buy-draw");
    });
  }

  private confirmAllHearts(amount: number, onConfirm: () => void): void {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("aria-labelledby", "confirm-all-title");
    dialog.innerHTML = `
      <section>
        <p class="eyebrow">IRREVERSIBLE COMMITMENT</p>
        <h2 id="confirm-all-title">Place all ${amount} HP?</h2>
        <p>This pair will receive every remaining heart. You cannot move them afterward.</p>
        <div>
          <button class="ghost" data-confirm-cancel>KEEP CHOOSING</button>
          <button class="primary" data-confirm-all>COMMIT ALL ${amount} HP</button>
        </div>
      </section>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.querySelector<HTMLElement>("[data-confirm-cancel]")?.addEventListener("click", () => dialog.close());
    dialog.querySelector<HTMLElement>("[data-confirm-all]")?.addEventListener("click", () => {
      onConfirm();
      dialog.close();
    });
    dialog.showModal();
  }

  private leave(): void {
    this.socket.emit("room:leave");
    localStorage.removeItem(SESSION_KEY);
    this.snapshot = null;
    this.selectedCardId = null;
    this.clearBattleTimers();
    this.clearOutcomeTimer();
    this.clearDrawTimers();
    this.renderLanding();
  }

  private updateClock(): void {
    const element = document.querySelector<HTMLElement>("#phase-clock");
    if (!element || this.snapshot?.kind !== "match") return;
    if (this.snapshot.phase === "finished") {
      element.textContent = "";
      element.classList.remove("urgent");
      return;
    }
    if (this.snapshot.deadlineAt === null) {
      element.textContent = "NO LIMIT";
      element.classList.remove("urgent");
      return;
    }
    const remaining = Math.max(0, this.snapshot.deadlineAt - (Date.now() + this.serverOffset));
    element.textContent = `00:${String(Math.ceil(remaining / 1_000)).padStart(2, "0")}`;
    element.classList.toggle("urgent", remaining <= 5_000);
  }

  private battleKey(view: MatchSnapshot): string | null {
    return view.battle ? `${view.roomCode}:${view.battle.round}` : null;
  }

  private outcomeKey(view: MatchSnapshot): string {
    const outcome = view.outcome;
    return `${view.roomCode}:${view.round}:outcome:${outcome?.kind ?? "none"}:${outcome?.winnerId ?? "none"}:${outcome?.reason ?? "none"}`;
  }

  private outcomeCrownDelay(view: MatchSnapshot): number {
    if (view.outcome?.reason !== "showdown") return 260;
    const shownHands = view.outcome.showdownSymbols?.filter((symbol) => symbol !== null).length ?? 0;
    return view.outcome.kind === "winner" && shownHands === 2 ? 3_250 : 1_750;
  }

  private startOutcomeSequence(
    view: MatchSnapshot,
    self: PublicPlayerView,
    battleSequencePending: boolean
  ): void {
    if (view.phase !== "finished" || !view.outcome || battleSequencePending) return;
    this.positionShowdownOrigins();
    const key = this.outcomeKey(view);
    if (this.completedOutcomeSequences.has(key) || this.activeOutcomeSequence?.key === key) return;
    this.clearOutcomeTimer();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 350 : this.outcomeCrownDelay(view) + 1_450;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      this.completedOutcomeSequences.add(key);
      this.activeOutcomeSequence = null;
      gameAudio.playOutcome(
        view.outcome!.kind === "draw" ? "draw" : view.outcome!.winnerId === self.id ? "win" : "loss"
      );
      if (this.snapshot?.kind === "match" && this.outcomeKey(this.snapshot) === key) this.render();
    }, duration);
    this.activeOutcomeSequence = { key, startedAt, timer };
  }

  private positionShowdownOrigins(): void {
    const felt = app.querySelector<HTMLElement>(".outcome-felt");
    if (!felt) return;
    const feltRect = felt.getBoundingClientRect();
    if (feltRect.width === 0 || feltRect.height === 0) return;
    const sources = [...app.querySelectorAll<HTMLElement>("[data-card-source-player]")];
    app.querySelectorAll<HTMLElement>("[data-showdown-player]").forEach((card) => {
      const source = sources.find((candidate) => candidate.dataset.cardSourcePlayer === card.dataset.showdownPlayer);
      if (!source) return;
      const sourceRect = source.getBoundingClientRect();
      const x = (sourceRect.left + sourceRect.width / 2 - feltRect.left) / feltRect.width * 100;
      const y = (sourceRect.top + sourceRect.height / 2 - feltRect.top) / feltRect.height * 100;
      card.style.setProperty("--card-from-x", `${x.toFixed(2)}%`);
      card.style.setProperty("--card-from-y", `${y.toFixed(2)}%`);
    });
  }

  private drawCardKey(view: MatchSnapshot, cardId: string): string {
    return `${view.roomCode}:${view.round}:draw:${cardId}`;
  }

  private startPairReveal(view: MatchSnapshot): void {
    const revealedIndex = view.phase === "preparation"
      ? view.activeLane - 1
      : view.battle
        ? 2
        : -1;
    if (revealedIndex < 0) return;
    const key = `${view.roomCode}:${view.round}:pair:${revealedIndex}`;
    if (this.revealedPairs.has(key)) return;
    this.revealedPairs.add(key);
    app.querySelector<HTMLElement>(`.battle-lane[data-slot="${revealedIndex}"]`)
      ?.classList.add("pair-just-revealed");
    if (view.phase === "preparation") gameAudio.playReveal();
  }

  private startDrawSequence(view: MatchSnapshot): void {
    if (view.phase !== "discard" || view.self.drawnCardIds.length === 0) return;
    const freshDraws = view.self.drawnCardIds.filter(
      (cardId) => !this.animatedDrawCards.has(this.drawCardKey(view, cardId))
    );
    if (freshDraws.length === 0) return;
    for (const cardId of freshDraws) this.animatedDrawCards.add(this.drawCardKey(view, cardId));

    const deck = app.querySelector<HTMLElement>(".deck-count");
    if (!deck) {
      app.querySelectorAll<HTMLElement>(".draw-pending").forEach((card) => card.classList.remove("draw-pending"));
      return;
    }

    const deckRect = deck.getBoundingClientRect();
    const startCenterX = deckRect.left + deckRect.width / 2;
    const startCenterY = deckRect.top + deckRect.height / 2;
    freshDraws.forEach((cardId, index) => {
      const target = app.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
      if (!target) return;
      const targetRect = target.getBoundingClientRect();
      const startX = startCenterX - targetRect.width / 2;
      const startY = startCenterY - targetRect.height / 2;
      const deltaX = targetRect.left - startX;
      const deltaY = targetRect.top - startY;
      const delay = index * 260;

      const flight = document.createElement("div");
      flight.className = "draw-card-flight board-card back";
      flight.innerHTML = cardBack();
      flight.style.left = `${startX}px`;
      flight.style.top = `${startY}px`;
      flight.style.width = `${targetRect.width}px`;
      flight.style.height = `${targetRect.height}px`;
      flight.style.setProperty("--draw-x", `${deltaX}px`);
      flight.style.setProperty("--draw-y", `${deltaY}px`);
      flight.style.setProperty("--draw-mid-x", `${deltaX / 2 + (index % 2 === 0 ? -25 : 25)}px`);
      flight.style.setProperty("--draw-mid-y", `${deltaY / 2 - 38}px`);
      flight.style.animationDelay = `${delay}ms`;
      document.body.append(flight);
      gameAudio.playDraw(delay);
      flight.addEventListener("animationend", () => flight.remove(), { once: true });

      const timer = window.setTimeout(() => {
        const current = app.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
        if (!current) return;
        current.classList.remove("draw-pending");
        current.classList.add("draw-arrived");
        current.addEventListener("animationend", () => current.classList.remove("draw-arrived"), { once: true });
      }, delay + 830);
      this.drawTimers.push(timer);
    });
  }

  private animateDiscardToDeck(card: HTMLElement): void {
    const deck = app.querySelector<HTMLElement>(".deck-count");
    if (!deck) return;
    const start = card.getBoundingClientRect();
    const end = deck.getBoundingClientRect();
    const deltaX = end.left + end.width / 2 - (start.left + start.width / 2);
    const deltaY = end.top + end.height / 2 - (start.top + start.height / 2);
    const flight = card.cloneNode(true) as HTMLElement;
    flight.classList.remove("selected", "discard-selected", "draw-pending", "draw-arrived");
    flight.classList.add("discard-card-flight");
    flight.removeAttribute("data-card-id");
    flight.removeAttribute("draggable");
    flight.style.left = `${start.left}px`;
    flight.style.top = `${start.top}px`;
    flight.style.width = `${start.width}px`;
    flight.style.height = `${start.height}px`;
    flight.style.setProperty("--discard-x", `${deltaX}px`);
    flight.style.setProperty("--discard-y", `${deltaY}px`);
    flight.style.setProperty("--discard-mid-x", `${deltaX / 2 + 42}px`);
    flight.style.setProperty("--discard-mid-y", `${deltaY / 2 - 42}px`);
    card.classList.add("discard-launching");
    document.body.append(flight);
    flight.addEventListener("animationend", () => {
      flight.remove();
      const currentDeck = app.querySelector<HTMLElement>(".deck-count");
      if (!currentDeck) return;
      currentDeck.classList.remove("deck-receive");
      void currentDeck.offsetWidth;
      currentDeck.classList.add("deck-receive");
      currentDeck.addEventListener("animationend", () => currentDeck.classList.remove("deck-receive"), { once: true });
    }, { once: true });
  }

  private shouldAnimateBattle(view: MatchSnapshot): boolean {
    const key = this.battleKey(view);
    if (!key || this.completedBattleSequences.has(key)) return false;
    return view.phase === "battle" || (view.phase === "finished" && view.outcome?.reason === "hp");
  }

  private hpBeforeBattle(view: MatchSnapshot, playerId: string): number {
    if (!view.battle) return view.players.find((player) => player.id === playerId)?.hp ?? 0;
    const playerIndex = view.battle.duelistIds.indexOf(playerId);
    if (playerIndex < 0) return view.players.find((player) => player.id === playerId)?.hp ?? 0;
    const placed = view.battle.lanes.reduce((total, lane) => {
      return total + (lane.sides.find((side) => side.playerId === playerId)?.hearts ?? 0);
    }, 0);
    return placed + view.battle.unassignedLost[playerIndex]!;
  }

  private bottomDuelistId(view: MatchSnapshot): string {
    if (!view.battle) return view.selfPlayerId;
    return view.battle.duelistIds.includes(view.selfPlayerId)
      ? view.selfPlayerId
      : view.battle.duelistIds[0];
  }

  private startBattleSequence(view: MatchSnapshot): void {
    if (!this.shouldAnimateBattle(view) || !view.battle) {
      if (this.activeBattleSequence && this.activeBattleSequence.key !== this.battleKey(view)) {
        this.clearBattleTimers();
      }
      return;
    }

    const key = this.battleKey(view)!;
    if (!this.activeBattleSequence || this.activeBattleSequence.key !== key) {
      this.clearBattleTimers();
      this.activeBattleSequence = { key, startedAt: performance.now(), timers: [] };
    } else {
      for (const timer of this.activeBattleSequence.timers) window.clearTimeout(timer);
      this.activeBattleSequence.timers = [];
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gap = reducedMotion ? 100 : 1_170;
    const clashOffset = reducedMotion ? 30 : 300;
    const resolveOffset = reducedMotion ? 65 : 690;
    // Leave the final lane visible until its transfer feedback has finished,
    // then hold the completed battle for five seconds before totals and any
    // final match outcome are shown.
    const animationFinishOffset = reducedMotion ? 110 : 2_010;
    const finishOffset = animationFinishOffset + 5_000;
    const elapsed = performance.now() - this.activeBattleSequence.startedAt;

    view.battle.lanes.forEach((lane, index) => {
      const revealAt = index * gap;
      this.scheduleBattleMoment(revealAt - elapsed, () => this.revealLane(index));
      this.scheduleBattleMoment(revealAt + clashOffset - elapsed, () => {
        this.clashLane(view, index, key);
      });
      this.scheduleBattleMoment(revealAt + resolveOffset - elapsed, () => {
        this.resolveLane(view, index, key);
      });
    });

    const lastLaneAt = (view.battle.lanes.length - 1) * gap;
    const collectionAt = lastLaneAt + animationFinishOffset;
    const collectionGap = 1_350;
    const collectionLeadIn = 350;
    const collectionTravel = reducedMotion ? 30 : 900;
    this.scheduleBattleMoment(collectionAt - elapsed, () => this.prepareHeartCollection(view));
    view.battle.lanes.forEach((lane, index) => {
      const departAt = collectionAt + collectionLeadIn + index * collectionGap;
      this.scheduleBattleMoment(departAt - elapsed, () => this.collectLaneHearts(view, index, key));
      this.scheduleBattleMoment(departAt + collectionTravel - elapsed, () => {
        this.settleLaneHearts(view, index);
      });
    });

    const completeAt = lastLaneAt + finishOffset;
    this.scheduleBattleMoment(completeAt - elapsed, () => {
      this.completedBattleSequences.add(key);
      this.clearBattleTimers();
      if (this.snapshot?.kind === "match" && this.battleKey(this.snapshot) === key) this.render();
    });
  }

  private scheduleBattleMoment(delay: number, callback: () => void): void {
    if (delay <= 0) {
      callback();
      return;
    }
    const timer = window.setTimeout(callback, delay);
    this.activeBattleSequence?.timers.push(timer);
  }

  private revealLane(index: number): void {
    app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`)?.classList.add("lane-revealing");
    gameAudio.playReveal();
  }

  private clashLane(view: MatchSnapshot, index: number, key: string): void {
    const laneElement = app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    const lane = view.battle?.lanes[index];
    const selfSide = lane?.sides.find((side) => side.playerId === this.bottomDuelistId(view));
    if (!laneElement || !lane || !selfSide) return;
    laneElement.classList.add("lane-clashing");
    laneElement.querySelector<HTMLElement>(".versus-line b")!.textContent = "CLASH";
    const moment = `${key}:clash:${index}`;
    if (!this.firedBattleMoments.has(moment)) {
      this.firedBattleMoments.add(moment);
      effects.events.emit("lane-clash-fx", { laneIndex: index, outcome: selfSide.result });
      const symbols = lane.sides.map((side) => side.symbol).filter((symbol): symbol is CardSymbol => symbol !== null);
      if (symbols.length === 2) gameAudio.playClash(symbols[0]!, symbols[1]!);
    }
  }

  private resolveLane(view: MatchSnapshot, index: number, key: string): void {
    const laneElement = app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    const lane = view.battle?.lanes[index];
    if (!laneElement || !lane) return;
    const bottomId = this.bottomDuelistId(view);
    const selfSide = lane.sides.find((side) => side.playerId === bottomId);
    const opponentSide = lane.sides.find((side) => side.playerId !== bottomId);
    if (!selfSide || !opponentSide) return;

    laneElement.classList.remove("lane-clashing");
    laneElement.classList.add("lane-resolved", `result-${selfSide.result}`);
    laneElement.querySelector<HTMLElement>(".versus-line b")!.textContent = selfSide.result.toUpperCase();
    const moment = `${key}:transfer:${index}`;
    const animate = !this.firedBattleMoments.has(moment);
    if (animate) this.firedBattleMoments.add(moment);
    this.applyHeartResult(laneElement, selfSide, opponentSide, animate);
  }

  private applyHeartResult(
    laneElement: HTMLElement,
    selfSide: BattleSideView,
    opponentSide: BattleSideView,
    animate: boolean
  ): void {
    const selfBadge = laneElement.querySelector<HTMLElement>('[data-lane-heart="self"]');
    const opponentBadge = laneElement.querySelector<HTMLElement>('[data-lane-heart="opponent"]');
    if (!selfBadge || !opponentBadge) return;

    const winner = selfSide.result === "win" ? selfSide : opponentSide.result === "win" ? opponentSide : null;
    const loser = winner === selfSide ? opponentSide : winner === opponentSide ? selfSide : null;
    if (animate && winner && loser) {
      const amount = Math.max(winner.receivedHp - winner.hearts, 0);
      const from = winner === selfSide ? opponentBadge : selfBadge;
      const to = winner === selfSide ? selfBadge : opponentBadge;
      if (amount > 0) this.flyHearts(from, to, amount, winner === selfSide);
      if (loser.hearts > 0) this.burnHeart(from, laneElement);
    }

    selfBadge.textContent = `♥ ${selfSide.receivedHp}`;
    opponentBadge.textContent = `♥ ${opponentSide.receivedHp}`;
  }

  private prepareHeartCollection(view: MatchSnapshot): void {
    app.querySelector<HTMLElement>(".battle-grid")?.classList.add("hearts-collecting");
    const message = app.querySelector<HTMLElement>(".reveal-message");
    if (message) message.textContent = "Collecting each card's hearts into total HP…";
    for (const playerId of view.battle?.duelistIds ?? []) {
      const total = app.querySelector<HTMLElement>(`[data-duelist-total-player="${playerId}"] .duelist-hp`);
      if (!total) continue;
      total.textContent = "♥ 0";
      total.classList.add("hp-collecting");
    }
  }

  private collectLaneHearts(view: MatchSnapshot, index: number, key: string): void {
    const lane = view.battle?.lanes[index];
    const laneElement = app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    if (!lane || !laneElement) return;
    laneElement.classList.add("lane-collecting");

    const moment = `${key}:collect:${index}`;
    const animate = !this.firedBattleMoments.has(moment);
    if (animate) this.firedBattleMoments.add(moment);

    for (const side of lane.sides) {
      const isSelf = side.playerId === this.bottomDuelistId(view);
      const source = laneElement.querySelector<HTMLElement>(
        `[data-lane-heart="${isSelf ? "self" : "opponent"}"]`
      );
      const target = app.querySelector<HTMLElement>(`[data-duelist-total-player="${side.playerId}"] .duelist-hp`);
      if (!source || !target) continue;
      source.classList.add("hearts-departing");
      if (animate && side.receivedHp > 0) {
        this.flyCollectedHearts(source, target, side.receivedHp, isSelf);
      }
    }
  }

  private settleLaneHearts(view: MatchSnapshot, index: number): void {
    const lane = view.battle?.lanes[index];
    const laneElement = app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    if (!lane || !laneElement || !view.battle) return;
    laneElement.classList.remove("lane-collecting");
    laneElement.classList.add("lane-collected");

    for (const side of lane.sides) {
      const isSelf = side.playerId === this.bottomDuelistId(view);
      const source = laneElement.querySelector<HTMLElement>(
        `[data-lane-heart="${isSelf ? "self" : "opponent"}"]`
      );
      if (source) {
        source.textContent = "♥ 0";
        source.classList.remove("hearts-departing");
        source.classList.add("hearts-collected");
      }

      const collected = view.battle.lanes.slice(0, index + 1).reduce((total, currentLane) => {
        return total + (currentLane.sides.find((candidate) => candidate.playerId === side.playerId)?.receivedHp ?? 0);
      }, 0);
      const target = app.querySelector<HTMLElement>(`[data-duelist-total-player="${side.playerId}"] .duelist-hp`);
      if (!target) continue;
      target.textContent = `♥ ${collected}`;
      target.classList.remove("hp-receiving");
      void target.offsetWidth;
      target.classList.add("hp-receiving");
      target.addEventListener("animationend", () => target.classList.remove("hp-receiving"), { once: true });
    }
  }

  private flyCollectedHearts(from: HTMLElement, to: HTMLElement, amount: number, towardSelf: boolean): void {
    const start = from.getBoundingClientRect();
    const end = to.getBoundingClientRect();
    const startX = start.left + start.width / 2;
    const startY = start.top + start.height / 2;
    const deltaX = end.left + end.width / 2 - startX;
    const deltaY = end.top + end.height / 2 - startY;
    const bundle = document.createElement("span");
    bundle.className = `collected-heart ${towardSelf ? "toward-self" : "toward-opponent"}`;
    bundle.innerHTML = `<b>♥</b><small>${amount}</small>`;
    bundle.style.left = `${startX}px`;
    bundle.style.top = `${startY}px`;
    bundle.style.setProperty("--collect-x", `${deltaX}px`);
    bundle.style.setProperty("--collect-y", `${deltaY}px`);
    bundle.style.setProperty("--collect-mid-x", `${deltaX / 2 + (towardSelf ? 22 : -22)}px`);
    bundle.style.setProperty("--collect-mid-y", `${deltaY / 2 - 28}px`);
    document.body.append(bundle);
    gameAudio.playHeartTing(0, amount);
    gameAudio.playHeartTing(760, amount + 1);
    bundle.addEventListener("animationend", () => bundle.remove(), { once: true });
  }

  private flyHearts(from: HTMLElement, to: HTMLElement, amount: number, towardSelf: boolean): void {
    const start = from.getBoundingClientRect();
    const end = to.getBoundingClientRect();
    const startX = start.left + start.width / 2;
    const startY = start.top + start.height / 2;
    const endX = end.left + end.width / 2;
    const endY = end.top + end.height / 2;
    const particleCount = Math.min(amount, 6);

    for (let index = 0; index < particleCount; index += 1) {
      const heart = document.createElement("span");
      heart.className = "flying-heart";
      heart.textContent = "♥";
      heart.style.left = `${startX}px`;
      heart.style.top = `${startY}px`;
      heart.style.setProperty("--heart-x", `${endX - startX}px`);
      heart.style.setProperty("--heart-y", `${endY - startY}px`);
      heart.style.setProperty("--heart-mid-x", `${(endX - startX) / 2}px`);
      heart.style.setProperty(
        "--heart-mid-y",
        `${(endY - startY) / 2 + (index % 2 === 0 ? -1 : 1) * (18 + index * 4)}px`
      );
      heart.style.animationDelay = `${index * 55}ms`;
      document.body.append(heart);
      gameAudio.playHeartTing(index * 55, index);
      heart.addEventListener("animationend", () => heart.remove(), { once: true });
    }

    const count = document.createElement("span");
    count.className = `heart-transfer-count ${towardSelf ? "toward-self" : "toward-opponent"}`;
    count.textContent = `+${amount} HP`;
    count.style.left = `${endX}px`;
    count.style.top = `${endY}px`;
    document.body.append(count);
    count.addEventListener("animationend", () => count.remove(), { once: true });
  }

  private burnHeart(from: HTMLElement, laneElement: HTMLElement): void {
    const source = from.getBoundingClientRect();
    const lane = laneElement.getBoundingClientRect();
    const burned = document.createElement("span");
    burned.className = "burned-heart";
    burned.innerHTML = "♥<small>−1</small>";
    burned.style.left = `${source.left + source.width / 2}px`;
    burned.style.top = `${lane.top + lane.height / 2}px`;
    document.body.append(burned);
    burned.addEventListener("animationend", () => burned.remove(), { once: true });
  }

  private clearBattleTimers(): void {
    if (!this.activeBattleSequence) return;
    for (const timer of this.activeBattleSequence.timers) window.clearTimeout(timer);
    this.activeBattleSequence = null;
  }

  private clearOutcomeTimer(): void {
    if (!this.activeOutcomeSequence) return;
    window.clearTimeout(this.activeOutcomeSequence.timer);
    this.activeOutcomeSequence = null;
  }

  private clearDrawTimers(): void {
    for (const timer of this.drawTimers) window.clearTimeout(timer);
    this.drawTimers.length = 0;
    document.querySelectorAll(".draw-card-flight, .discard-card-flight").forEach((element) => element.remove());
  }

  private showToast(message: string, isError = false): void {
    toast.textContent = message;
    toast.className = `visible ${isError ? "error" : ""}`;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      toast.className = "";
      this.toastTimer = null;
    }, 3_600);
  }
}

new RpsClient();
