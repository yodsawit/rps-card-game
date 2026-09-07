import type { Socket } from "socket.io-client";
import { MatchLogView } from "./views/match-log.js";
import { MatchViews } from "./views/match.js";
import { MatchPresentation } from "./presentation/match.js";
import { renderHome } from "./views/home.js";
import { renderLobby } from "./views/lobby.js";
import { escapeHtml, symbolLabel, symbolGraphic, cardFace, cardBack, phaseLabel } from "./views/components.js";
import { browserClock } from "./clock.js";
import type { Ack, ClientToServerEvents, LobbySnapshot, MatchSnapshot, PublicPlayerView, ServerSnapshot, ServerToClientEvents, SessionReceipt } from "@rps/protocol";
import type { startEffects } from "./fx.js";
import type { GameAudio } from "./audio.js";
import { updateMarkup } from "./dom.js";

const SESSION_KEY = "rps-session-v1";
const NAME_KEY = "rps-player-name";
const LANE_NAMES = ["LEFT", "CENTER", "RIGHT"] as const;

export interface ApplicationDependencies {
  app: HTMLDivElement;
  toast: HTMLDivElement;
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  effects: Pick<ReturnType<typeof startEffects>, "events">;
  audio: GameAudio;
  clock?: typeof browserClock;
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






export class RpsClient {
  private readonly presentation: MatchPresentation;
  private get views(): MatchViews {
    return new MatchViews({
      outcomeKey: (view) => this.presentation.outcomeKey(view),
      activeOutcomeSequence: this.presentation.activeOutcomeSequence,
      clock: this.clock,
      outcomeCrownDelay: (view) => this.presentation.outcomeCrownDelay(view),
      completedBattleSequences: this.presentation.completedBattleSequences,
      hpBeforeBattle: (view, playerId) => this.presentation.hpBeforeBattle(view, playerId),
      selectedCardId: this.selectedCardId,
      animatedDrawCards: this.presentation.animatedDrawCards,
      drawCardKey: (view, cardId) => this.presentation.drawCardKey(view, cardId),
      matchLogOpen: this.matchLogOpen,
      log: this.log
    });
  }
  private readonly log = new MatchLogView();
  private readonly app;
  private readonly toast;
  private readonly gameAudio;
  private readonly clock;
  private readonly clockTimer;
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private snapshot: ServerSnapshot | null = null;
  private selectedCardId: string | null = null;
  private serverOffset = 0;
  private matchLogOpen = false;
  private toastTimer: number | null = null;
  private matchEvents = new AbortController();

  constructor(dependencies: ApplicationDependencies) {
    this.app = dependencies.app;
    this.toast = dependencies.toast;
    this.gameAudio = dependencies.audio;
    this.clock = dependencies.clock ?? browserClock;
    this.socket = dependencies.socket;
    this.presentation = new MatchPresentation({ ...dependencies,
      snapshot: () => this.snapshot, render: () => this.render() });
    this.socket.on("connect", () => this.resumeOrRender());
    this.socket.on("disconnect", () => this.showToast("Connection lost. Reconnecting for up to 30 seconds…", true));
    this.socket.on("state:error", (message) => this.showToast(message, true));
    this.socket.on("state:snapshot", (snapshot) => {
      const previous = this.snapshot;
      if (previous?.kind === "match" && (snapshot.kind !== "match"
        || previous.phase !== snapshot.phase || previous.activeLane !== snapshot.activeLane || previous.round !== snapshot.round)) {
        document.querySelectorAll<HTMLDialogElement>(".confirm-dialog").forEach((dialog) => dialog.close());
      }
      if (
        this.snapshot?.kind === "match" &&
        this.snapshot.phase === "finished" &&
        snapshot.kind === "match" &&
        snapshot.roomCode === this.snapshot.roomCode &&
        snapshot.phase === "targeting" &&
        snapshot.round === 1
      ) {
        this.presentation.completedBattleSequences.clear();
        this.presentation.clearOutcomeTimer();
        this.presentation.completedOutcomeSequences.clear();
        this.matchLogOpen = false;
        this.log.selectedLogRound = null;
        this.log.selectedLogTab = "resolve";
        this.presentation.firedBattleMoments.clear();
        this.presentation.animatedDrawCards.clear();
        this.presentation.animatingDrawCards.clear();
        this.presentation.revealedPairs.clear();
      }
      this.snapshot = snapshot;
      if (snapshot.kind === "match") this.serverOffset = snapshot.serverNow - this.clock.now();
      this.render();
    });
    this.clockTimer = this.clock.setInterval(() => this.updateClock(), 100);
  }

  dispose(): void {
    this.clock.clearInterval(this.clockTimer);
    this.presentation.dispose();
    if (this.toastTimer !== null) this.clock.clearTimeout(this.toastTimer);
    this.matchEvents.abort();
    this.socket.removeAllListeners();
    this.socket.disconnect();
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
    this.app.innerHTML = renderHome(savedName);
    this.app.querySelector<HTMLElement>("[data-action='create']")?.addEventListener("click", () => this.create());
    this.app.querySelector<HTMLElement>("[data-action='join']")?.addEventListener("click", () => this.join());
    this.app.querySelector<HTMLElement>("[data-action='how-to']")?.addEventListener("click", () => this.openTutorial());
    this.app.querySelector<HTMLInputElement>("#room-code")?.addEventListener("input", (event) => {
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
          <p>The host chooses a 20-second, 30-second, or unlimited action timer. Locking or timing out without a card uses your leftmost available card. The first two pairs start at 0 HP; the final pair always receives all remaining HP.</p>`,
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
          <p>When the deck is empty, no more cards are drawn and no discard is owed for a missing draw. Your hand can hold at most five cards. Five matching cards after discard wins immediately. A player at 0 HP is eliminated.</p>`,
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
    return this.app.querySelector<HTMLInputElement>("#player-name")?.value.trim() ?? "";
  }

  private create(): void {
    const name = this.playerName();
    this.socket.emit("room:create", { name }, (result) => {
      this.handleReceipt(result, name);
    });
  }

  private join(): void {
    const name = this.playerName();
    const roomCode = this.app.querySelector<HTMLInputElement>("#room-code")?.value ?? "";
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
    this.app.innerHTML = renderLobby(view);
    this.app.querySelector<HTMLElement>("[data-action='copy']")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(view.roomCode);
      this.showToast("Room code copied.");
    });
    this.app.querySelector<HTMLElement>("[data-action='add-basic-bot']")?.addEventListener("click", () => this.socket.emit("room:add-bot", { difficulty: "basic" }));
    this.app.querySelector<HTMLElement>("[data-action='add-advanced-bot']")?.addEventListener("click", () => this.socket.emit("room:add-bot", { difficulty: "advanced" }));
    this.app.querySelector<HTMLElement>("[data-action='add-learned-bot']")?.addEventListener("click", () => this.socket.emit("room:add-bot", { difficulty: "learned" }));
    const timerDropdown = this.app.querySelector<HTMLElement>("[data-timer-dropdown]");
    const timerTrigger = timerDropdown?.querySelector<HTMLButtonElement>("[data-action='toggle-timer']");
    timerTrigger?.addEventListener("click", () => {
      const isOpen = timerDropdown!.classList.toggle("open");
      timerTrigger.setAttribute("aria-expanded", String(isOpen));
    });
    timerDropdown?.addEventListener("focusout", () => {
      this.clock.setTimeout(() => {
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
    this.app.querySelectorAll<HTMLButtonElement>("[data-action-time]").forEach((option) => {
      option.addEventListener("click", () => {
        const actionTimeMs = option.dataset.actionTime === "none" ? null : Number(option.dataset.actionTime) as 20_000 | 30_000;
        timerDropdown?.classList.remove("open");
        timerTrigger?.setAttribute("aria-expanded", "false");
        this.socket.emit("room:set-action-time", { actionTimeMs });
      });
    });
    this.app.querySelector<HTMLElement>("[data-action='start']")?.addEventListener("click", () => this.socket.emit("room:start"));
    this.app.querySelectorAll<HTMLElement>("[data-remove-bot]").forEach((button) => {
      button.addEventListener("click", () => this.socket.emit("room:remove-bot", { playerId: button.dataset.removeBot! }));
    });
    this.app.querySelector<HTMLElement>("[data-action='leave']")?.addEventListener("click", () => this.leave());
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
    const sequencePending = this.presentation.shouldAnimateBattle(view);
    const outcomeSequencePending = view.phase === "finished"
      && !sequencePending
      && view.outcome !== null
      && !this.presentation.completedOutcomeSequences.has(this.presentation.outcomeKey(view));
    const displayBottomHp = sequencePending ? this.presentation.hpBeforeBattle(view, bottom.id) : bottom.hp;
    const unassigned = view.phase === "preparation" && selfIsDuelist
      ? self.hp - self.slots.reduce((total, slot) => total + slot.hearts, 0)
      : 0;
    const body = view.phase === "finished" && !sequencePending
      ? this.views.finalTable(view)
      : view.phase === "targeting"
        ? this.views.targetTable(view, self, attacker)
        : view.phase === "discard"
          ? selfIsDuelist
            ? this.views.discardPanel(view, self, opponent)
            : this.views.spectatorPanel(view, attacker, defender)
          : this.views.battleBoard(view, self, bottom, opponent, unassigned, displayBottomHp, sequencePending);

    updateMarkup(this.app, `
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
      ${view.phase === "finished" && !sequencePending && !outcomeSequencePending ? this.views.resultOverlay(view, self) : ""}
    `);

    this.bindMatch(view, self, selfIsDuelist);
    const modal = this.app.querySelector<HTMLDialogElement>(".result-scrim > dialog");
    if (modal && !modal.open) modal.showModal();
    this.updateClock();
    this.presentation.startPairReveal(view);
    this.presentation.startBattleSequence(view);
    this.presentation.startDrawSequence(view);
    this.presentation.startOutcomeSequence(view, self, sequencePending);
  }





















  private bindMatch(view: MatchSnapshot, self: PublicPlayerView, selfIsDuelist: boolean): void {
    this.matchEvents.abort();
    this.matchEvents = new AbortController();
    const { signal } = this.matchEvents;
    this.app.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLElement>("button, [data-drop-slot]");
      if (!button || button instanceof HTMLButtonElement && button.disabled) return;
      const data = button.dataset;
      if (data.targetPlayer) this.socket.emit("match:target", { playerId: data.targetPlayer });
      else if (data.cardId) {
        const cardId = data.cardId;
        if (view.phase === "discard" && selfIsDuelist && !self.locked) {
          const selected = view.self.discardSelection.includes(cardId);
          const next = selected ? view.self.discardSelection.filter((id) => id !== cardId) : [...view.self.discardSelection, cardId];
          if (next.length <= view.self.requiredDiscards) {
            if (!selected) { this.gameAudio.playDiscard(); this.presentation.animateDiscardToDeck(button); }
            this.socket.emit("match:discard", { cardIds: next });
          }
        } else if (view.phase === "preparation" && selfIsDuelist && !self.locked && !view.self.slotCardIds.includes(cardId)) {
          this.selectedCardId = this.selectedCardId === cardId ? null : cardId;
          this.render();
        }
      } else if (data.dropSlot !== undefined && view.phase === "preparation" && selfIsDuelist && !self.locked && Number(data.dropSlot) === view.activeLane) {
        if (!this.selectedCardId) { this.showToast("Select a card from your hand first."); return; }
        this.socket.emit("match:place", { slotIndex: view.activeLane, cardId: this.selectedCardId });
        this.gameAudio.playCardPlace();
        this.selectedCardId = null;
      } else if (data.heart !== undefined) {
        const delta = Number(data.heart);
        const commit = (): void => { this.socket.emit("match:hearts", { slotIndex: Number(data.index), delta }); };
        if (data.heartMode === "all") this.confirmAllHearts(delta, commit);
        else commit();
      } else if (data.logTab) {
        this.log.selectedLogTab = data.logTab === "cards" ? "cards" : "resolve";
        this.render();
      } else if (data.logNav) {
        const current = Math.max(view.matchLog.findIndex((entry) => entry.round === this.log.selectedLogRound), 0);
        const index = data.logNav === "first" ? 0 : data.logNav === "last" ? view.matchLog.length - 1 : current + (data.logNav === "previous" ? -1 : 1);
        this.log.selectedLogRound = view.matchLog[Math.max(0, Math.min(index, view.matchLog.length - 1))]?.round ?? null;
        this.render();
      } else if (data.action === "lock") { this.gameAudio.playLock(); this.socket.emit("match:lock"); }
      else if (data.action === "buy-draw") this.socket.emit("match:buy-draw");
      else if (data.action === "leave") this.leave();
      else if (data.action === "rematch") this.socket.emit("room:rematch");
      else if (data.action === "view-log") {
        this.matchLogOpen = true;
        this.log.selectedLogRound = view.matchLog[0]?.round ?? null;
        this.log.selectedLogTab = "resolve";
        this.render();
      } else if (data.action === "close-log") { this.matchLogOpen = false; this.render(); }
    }, { signal });
    this.app.addEventListener("keydown", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if ((event.key === "Enter" || event.key === " ") && target?.matches('[data-drop-slot][role="button"]')) {
        event.preventDefault(); target.click();
      }
    }, { signal });
    this.app.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (this.matchLogOpen) { this.matchLogOpen = false; this.render(); }
    }, { capture: true, signal });
    this.app.addEventListener("dragstart", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-card-id]") : null;
      if (target) event.dataTransfer?.setData("text/card-id", target.dataset.cardId!);
    }, { signal });
    this.app.addEventListener("dragover", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-drop-slot]")) event.preventDefault();
    }, { signal });
    this.app.addEventListener("drop", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drop-slot]") : null;
      if (!target || view.phase !== "preparation" || !selfIsDuelist || self.locked || Number(target.dataset.dropSlot) !== view.activeLane) return;
      event.preventDefault();
      const cardId = event.dataTransfer?.getData("text/card-id");
      if (cardId) { this.gameAudio.playCardPlace(); this.socket.emit("match:place", { slotIndex: view.activeLane, cardId }); }
    }, { signal });
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
    this.matchLogOpen = false;
    this.log.selectedLogRound = null;
    this.log.selectedLogTab = "resolve";
    this.presentation.clearBattleTimers();
    this.presentation.clearOutcomeTimer();
    this.presentation.clearDrawTimers();
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
    const remaining = Math.max(0, this.snapshot.deadlineAt - (this.clock.now() + this.serverOffset));
    element.textContent = `00:${String(Math.ceil(remaining / 1_000)).padStart(2, "0")}`;
    element.classList.toggle("urgent", remaining <= 5_000);
  }


  private showToast(message: string, isError = false): void {
    this.toast.textContent = message;
    this.toast.className = `visible ${isError ? "error" : ""}`;
    if (this.toastTimer !== null) this.clock.clearTimeout(this.toastTimer);
    this.toastTimer = this.clock.setTimeout(() => {
      this.toast.className = "";
      this.toastTimer = null;
    }, 3_600);
  }
}

export function createApplication(dependencies: ApplicationDependencies): RpsClient {
  return new RpsClient(dependencies);
}
