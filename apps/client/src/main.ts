import "./style.css";
import { io, type Socket } from "socket.io-client";
import type { Card, CardSymbol, LaneResult } from "@rps/game-core";
import type {
  Ack,
  BattleSideView,
  ClientToServerEvents,
  MatchSnapshot,
  PublicPlayerView,
  ServerSnapshot,
  ServerToClientEvents,
  SessionReceipt
} from "@rps/protocol";
import { startEffects } from "./fx.js";

const SESSION_KEY = "rps-session-v1";
const NAME_KEY = "rps-player-name";
const LANE_NAMES = ["LEFT", "CENTER", "RIGHT"] as const;

const app = document.querySelector<HTMLDivElement>("#app")!;
const toast = document.querySelector<HTMLDivElement>("#toast")!;
if (!app || !toast) throw new Error("Application shell is missing.");

const effects = startEffects();

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
        snapshot.phase === "preparation" &&
        snapshot.round === 1
      ) {
        this.completedBattleSequences.clear();
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
      this.renderWaitingRoom(this.snapshot.roomCode, this.snapshot.players[0]?.name ?? "Player");
      return;
    }
    this.renderMatch(this.snapshot);
  }

  private renderLanding(): void {
    const savedName = escapeHtml(localStorage.getItem(NAME_KEY) ?? "");
    app.innerHTML = `
      <main class="landing shell">
        <section class="brand-block">
          <p class="eyebrow">THREE CARDS. TEN HEARTS. NO SAFE BETS.</p>
          <h1><span>R</span><span>P</span><span>S</span></h1>
          <p class="tagline">Read the board. Hide the hand. Put your hearts where your nerve is.</p>
        </section>
        <section class="lobby-panel glass-panel">
          <label class="field-label" for="player-name">CALLSIGN</label>
          <input id="player-name" maxlength="18" autocomplete="nickname" value="${savedName}" placeholder="Player name" />
          <button class="primary wide" data-action="computer">
            <span>PLAY VS COMPUTER</span><small>Instant private match</small>
          </button>
          <button class="secondary wide" data-action="create">
            <span>CREATE ONLINE ROOM</span><small>Invite with a five-character code</small>
          </button>
          <div class="join-row">
            <input id="room-code" maxlength="5" autocomplete="off" placeholder="ROOM CODE" />
            <button class="ghost" data-action="join">JOIN</button>
          </div>
          <div class="rules-strip"><span>15 CARDS</span><span>3 LANES</span><span>20 SECONDS</span></div>
        </section>
      </main>
      <footer class="landing-footer">ROCK BREAKS SCISSORS · SCISSORS CUT PAPER · PAPER COVERS ROCK</footer>
    `;
    app.querySelector<HTMLElement>("[data-action='computer']")?.addEventListener("click", () => this.create(true));
    app.querySelector<HTMLElement>("[data-action='create']")?.addEventListener("click", () => this.create(false));
    app.querySelector<HTMLElement>("[data-action='join']")?.addEventListener("click", () => this.join());
    app.querySelector<HTMLInputElement>("#room-code")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      target.value = target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
  }

  private playerName(): string {
    return app.querySelector<HTMLInputElement>("#player-name")?.value.trim() ?? "";
  }

  private create(versusComputer: boolean): void {
    const name = this.playerName();
    this.socket.emit("room:create", { name, versusComputer }, (result) => {
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

  private renderWaitingRoom(roomCode: string, name: string): void {
    app.innerHTML = `
      <main class="waiting shell">
        <section class="glass-panel waiting-card">
          <p class="eyebrow">ROOM READY</p>
          <h2>${escapeHtml(name)}, your table is open.</h2>
          <p class="muted">Send this code to your opponent.</p>
          <button class="room-code" data-action="copy" aria-label="Copy room code">${escapeHtml(roomCode)}</button>
          <p class="waiting-pulse"><i></i> Waiting for challenger</p>
          <button class="text-button" data-action="leave">Leave room</button>
        </section>
      </main>
    `;
    app.querySelector<HTMLElement>("[data-action='copy']")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(roomCode);
      this.showToast("Room code copied.");
    });
    app.querySelector<HTMLElement>("[data-action='leave']")?.addEventListener("click", () => this.leave());
  }

  private renderMatch(view: MatchSnapshot): void {
    const self = view.players.find((player) => player.id === view.selfPlayerId)!;
    const opponent = view.players.find((player) => player.id !== view.selfPlayerId)!;
    const sequencePending = this.shouldAnimateBattle(view);
    const displaySelfHp = sequencePending ? this.hpBeforeBattle(view, self.id) : self.hp;
    const displayOpponentHp = sequencePending ? this.hpBeforeBattle(view, opponent.id) : opponent.hp;
    const unassigned = view.phase === "preparation"
      ? self.hp - self.slots.reduce((total, slot) => total + slot.hearts, 0)
      : 0;
    const body = view.phase === "discard"
      ? this.discardPanel(view, self, opponent)
      : this.battleBoard(view, self, opponent, unassigned, displaySelfHp, sequencePending);

    app.innerHTML = `
      <main class="match-shell">
        <header class="match-header">
          <div class="identity opponent-id">
            <span class="connection ${opponent.connected ? "online" : "offline"}"></span>
            <div><small>OPPONENT</small><strong>${escapeHtml(opponent.name)}${opponent.isBot ? " // CPU" : ""}</strong></div>
            <span class="total-hp" data-total-player="${opponent.id}">♥ ${displayOpponentHp}</span>
          </div>
          <div class="round-clock">
            <small>ROUND ${view.round}</small>
            <strong>${sequencePending ? "REVEAL" : view.phase === "preparation" ? `${LANE_NAMES[view.activeLane]} PAIR` : phaseLabel(view.phase)}</strong>
            <span id="phase-clock">--:--</span>
          </div>
          <div class="header-actions">
            <span class="deck-count">DECK ${view.deckCount}</span>
            <button class="icon-button" data-action="leave" title="Leave match">×</button>
          </div>
        </header>
        ${body}
      </main>
      ${view.phase === "finished" && !sequencePending ? this.resultOverlay(view, self, opponent) : ""}
    `;

    this.bindMatch(view, self, unassigned);
    this.updateClock();
    this.startPairReveal(view);
    this.startBattleSequence(view);
    this.startDrawSequence(view);
  }

  private battleBoard(
    view: MatchSnapshot,
    self: PublicPlayerView,
    opponent: PublicPlayerView,
    unassigned: number,
    displaySelfHp: number,
    sequencePending: boolean
  ): string {
    const collectionComplete = Boolean(
      view.battle && this.completedBattleSequences.has(`${view.roomCode}:${view.battle.round}`)
    );
    const lanes = [0, 1, 2].map((index) => {
      const opponentBattle = view.battle?.lanes[index]?.sides.find((side) => side.playerId === opponent.id);
      const selfBattle = view.battle?.lanes[index]?.sides.find((side) => side.playerId === self.id);
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
            ${this.boardCard(self.slots[index]!, selfBattle?.symbol ?? self.slots[index]!.symbol, true, view.phase, emptyLabel)}
            <span class="heart-badge own" data-lane-heart="self">♥ ${collectionComplete ? 0 : selfBattle?.hearts ?? self.slots[index]!.hearts}</span>
            ${view.phase === "preparation" && !self.locked && index === view.activeLane ? `
              ${view.activeLane < 2 ? `<div class="heart-controls">
                <button data-heart="-1" data-index="${index}" ${self.slots[index]!.hearts <= 0 ? "disabled" : ""}>−</button>
                <button data-heart="1" data-index="${index}" ${!self.slots[index]!.occupied || unassigned <= 0 ? "disabled" : ""}>+</button>
              </div>` : self.slots[index]!.occupied ? '<span class="forced-allocation">ALL REMAINING HP</span>' : ""}
              ${self.slots[index]!.occupied ? `<button class="remove-card" data-remove="${index}" title="Return card to hand">×</button>` : ""}
            ` : ""}
          </div>
        </section>
      `;
    }).join("");

    return `
      <section class="opponent-hand-row" aria-label="Opponent hand">
        ${Array.from({ length: opponent.handCount }, () => `<span class="mini-back">${cardBack()}</span>`).join("")}
      </section>
      <section class="battle-grid ${sequencePending ? "battle-sequence cards-pre-revealed" : ""}">${lanes}</section>
      <section class="player-console">
        <div class="self-summary">
          <span><small>YOUR HP</small><strong data-total-player="${self.id}">♥ ${displaySelfHp}</strong></span>
          <span class="unassigned ${view.phase === "preparation" && view.activeLane === 2 && !self.slots[2].occupied ? "danger" : "safe"}"><small>HP LEFT</small><strong>♥ ${unassigned}</strong></span>
        </div>
        <div class="hand-row">${view.self.hand.map((card) => this.handCard(card, self, view)).join("")}</div>
        ${view.phase === "preparation" ? `
          <div class="phase-actions">
            <p>${self.locked
              ? `Pair ${view.activeLane + 1} locked. Waiting for opponent.`
              : view.activeLane < 2
                ? self.slots[view.activeLane].occupied
                  ? `${unassigned} HP remains available for later pairs.`
                  : "An empty pair auto-loses; unused HP remains for later pairs."
                : self.slots[2].occupied
                  ? `The final card automatically carries all ${self.slots[2].hearts} remaining HP.`
                  : `${unassigned} HP will be lost unless you place the final card.`}</p>
            <button class="primary lock-button" data-action="lock" ${self.locked ? "disabled" : ""}>${self.locked ? "LOCKED" : `LOCK PAIR ${view.activeLane + 1}`}</button>
          </div>
        ` : view.phase === "battle" || sequencePending ? '<p class="reveal-message">Cards revealed. Resolving lanes, then collecting every card\'s hearts…</p>' : ""}
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
    if (!slot.occupied) {
      return `<div class="board-card empty"><span>${emptyLabel}</span><small>${emptyLabel === "WAITING" ? `PAIR ${phase === "preparation" ? "PENDING" : ""}` : "AUTO-LOSS"}</small></div>`;
    }
    if (revealedSymbol) {
      return `<div class="board-card face ${own ? "owned" : "revealed"}">${cardFace(revealedSymbol)}</div>`;
    }
    return `<div class="board-card back">${cardBack()}</div>`;
  }

  private handCard(card: Card, self: PublicPlayerView, view: MatchSnapshot): string {
    const selectedForDiscard = view.self.discardSelection.includes(card.id);
    const selected = this.selectedCardId === card.id;
    const placedIndex = view.self.slotCardIds.indexOf(card.id);
    const committed = view.phase === "preparation" && placedIndex >= 0 && placedIndex < view.activeLane;
    const drawPending = view.phase === "discard"
      && view.self.drawnCardIds.includes(card.id)
      && !this.animatedDrawCards.has(this.drawCardKey(view, card.id));
    return `
      <button class="hand-card face ${card.symbol} ${selected ? "selected" : ""} ${selectedForDiscard ? "discard-selected" : ""} ${drawPending ? "draw-pending" : ""} ${committed ? "committed" : ""}"
        data-card-id="${card.id}" draggable="${view.phase === "preparation" && !self.locked && !committed}" ${committed ? "disabled" : ""}>
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

  private resultOverlay(view: MatchSnapshot, self: PublicPlayerView, opponent: PublicPlayerView): string {
    const won = view.outcome?.winnerId === self.id;
    const draw = view.outcome?.kind === "draw";
    const title = draw ? "DRAW" : won ? "VICTORY" : "DEFEAT";
    const detail = view.outcome?.reason === "showdown"
      ? "Five of a kind decided the table."
      : view.outcome?.reason === "forfeit"
        ? "A disconnect passed the match."
        : draw
          ? "Both players reached zero HP."
          : `${escapeHtml(won ? opponent.name : self.name)} ran out of hearts.`;
    return `
      <div class="result-scrim">
        <section class="result-card ${draw ? "draw" : won ? "win" : "loss"}">
          <p class="eyebrow">MATCH COMPLETE</p>
          <h2>${title}</h2>
          <p>${detail}</p>
          <div class="result-actions">
            <button class="primary" data-action="rematch" ${self.rematchRequested ? "disabled" : ""}>${self.rematchRequested ? "REMATCH REQUESTED" : opponent.isBot ? "PLAY AGAIN" : "REQUEST REMATCH"}</button>
            <button class="ghost" data-action="leave">LEAVE TABLE</button>
          </div>
        </section>
      </div>
    `;
  }

  private bindMatch(view: MatchSnapshot, self: PublicPlayerView, unassigned: number): void {
    app.querySelectorAll<HTMLElement>("[data-card-id]").forEach((element) => {
      element.addEventListener("click", () => {
        const cardId = element.dataset.cardId!;
        if (view.phase === "discard" && !self.locked) {
          const alreadySelected = view.self.discardSelection.includes(cardId);
          const next = alreadySelected
            ? view.self.discardSelection.filter((id) => id !== cardId)
            : [...view.self.discardSelection, cardId];
          if (next.length <= view.self.requiredDiscards) {
            if (!alreadySelected) this.animateDiscardToDeck(element);
            this.socket.emit("match:discard", { cardIds: next });
          }
          return;
        }
        if (view.phase === "preparation" && !self.locked) {
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
        if (cardId) this.socket.emit("match:place", { slotIndex: Number(element.dataset.dropSlot), cardId });
      });
      element.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (
          view.phase === "preparation"
          && !self.locked
          && Number(element.dataset.dropSlot) === view.activeLane
          && this.selectedCardId
        ) {
          this.socket.emit("match:place", {
            slotIndex: Number(element.dataset.dropSlot),
            cardId: this.selectedCardId
          });
          this.selectedCardId = null;
        }
      });
    });

    app.querySelectorAll<HTMLButtonElement>("[data-heart]").forEach((button) => {
      button.addEventListener("click", () => this.socket.emit("match:hearts", {
        slotIndex: Number(button.dataset.index),
        delta: Number(button.dataset.heart)
      }));
    });
    app.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => {
      button.addEventListener("click", () => this.socket.emit("match:place", {
        slotIndex: Number(button.dataset.remove),
        cardId: null
      }));
    });
    app.querySelectorAll<HTMLElement>("[data-action='lock']").forEach((button) => {
      button.addEventListener("click", () => {
        if (view.phase === "preparation" && !self.slots[view.activeLane].occupied) {
          const warning = view.activeLane === 2
            ? `The final pair will be empty and all ${unassigned} remaining HP will be lost. Continue?`
            : "This pair will be empty and count as a loss. Remaining HP will carry forward. Continue?";
          const accepted = window.confirm(warning);
          if (!accepted) return;
        }
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

  private leave(): void {
    this.socket.emit("room:leave");
    localStorage.removeItem(SESSION_KEY);
    this.snapshot = null;
    this.selectedCardId = null;
    this.clearBattleTimers();
    this.clearDrawTimers();
    this.renderLanding();
  }

  private updateClock(): void {
    const element = document.querySelector<HTMLElement>("#phase-clock");
    if (!element || this.snapshot?.kind !== "match") return;
    if (this.snapshot.deadlineAt === null) {
      element.textContent = "—";
      return;
    }
    const remaining = Math.max(0, this.snapshot.deadlineAt - (Date.now() + this.serverOffset));
    element.textContent = `00:${String(Math.ceil(remaining / 1_000)).padStart(2, "0")}`;
    element.classList.toggle("urgent", remaining <= 5_000);
  }

  private battleKey(view: MatchSnapshot): string | null {
    return view.battle ? `${view.roomCode}:${view.battle.round}` : null;
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
    const playerIndex = view.players.findIndex((player) => player.id === playerId);
    if (playerIndex < 0) return 0;
    const placed = view.battle.lanes.reduce((total, lane) => {
      return total + (lane.sides.find((side) => side.playerId === playerId)?.hearts ?? 0);
    }, 0);
    return placed + view.battle.unassignedLost[playerIndex]!;
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
  }

  private clashLane(view: MatchSnapshot, index: number, key: string): void {
    const laneElement = app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    const lane = view.battle?.lanes[index];
    const selfSide = lane?.sides.find((side) => side.playerId === view.selfPlayerId);
    if (!laneElement || !selfSide) return;
    laneElement.classList.add("lane-clashing");
    laneElement.querySelector<HTMLElement>(".versus-line b")!.textContent = "CLASH";
    const moment = `${key}:clash:${index}`;
    if (!this.firedBattleMoments.has(moment)) {
      this.firedBattleMoments.add(moment);
      effects.events.emit("lane-clash-fx", { laneIndex: index, outcome: selfSide.result });
    }
  }

  private resolveLane(view: MatchSnapshot, index: number, key: string): void {
    const laneElement = app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    const lane = view.battle?.lanes[index];
    if (!laneElement || !lane) return;
    const selfSide = lane.sides.find((side) => side.playerId === view.selfPlayerId);
    const opponentSide = lane.sides.find((side) => side.playerId !== view.selfPlayerId);
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
    for (const player of view.players) {
      const total = app.querySelector<HTMLElement>(`[data-total-player="${player.id}"]`);
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
      const isSelf = side.playerId === view.selfPlayerId;
      const source = laneElement.querySelector<HTMLElement>(
        `[data-lane-heart="${isSelf ? "self" : "opponent"}"]`
      );
      const target = app.querySelector<HTMLElement>(`[data-total-player="${side.playerId}"]`);
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
      const isSelf = side.playerId === view.selfPlayerId;
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
      const target = app.querySelector<HTMLElement>(`[data-total-player="${side.playerId}"]`);
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
