import type { CardSymbol } from "@rps/game-core";
import type { MatchSnapshot, PublicPlayerView } from "@rps/protocol";
import { escapeHtml, cardFace, cardBack } from "./components.js";
import type { MatchViewState } from "./match-state.js";
import { cardCountDisplay } from "./player.js";
import { DrawViews } from "./draw.js";
const LANE_NAMES = ["LEFT", "CENTER", "RIGHT"] as const;
export class BattleViews {
  constructor(private readonly state: MatchViewState) {}
  duelistBox(
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
        ${cardCountDisplay(cardsLeft, "individual")}
        <b class="duelist-hp">&hearts; ${shownHp}</b>
      </section>`;
  }

  spectatorPanel(
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

  battleBoard(
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
      view.battle && this.state.completedBattleSequences.has(`${view.roomCode}:${view.battle.round}`)
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
          <span class="pair-phase-label" aria-hidden="true">${view.phase === "preparation" && index === view.activeLane ? "CURRENT PAIR" : ""}</span>
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
          <div class="slot self-slot" data-drop-slot="${index}" ${view.phase === "preparation" && selfIsDuelist && index === view.activeLane && !self.locked ? `role="button" tabindex="0" aria-label="Place selected card in ${LANE_NAMES[index].toLowerCase()} pair"` : ""}>
            ${this.boardCard(bottom.slots[index]!, selfBattle?.symbol ?? bottom.slots[index]!.symbol, true, view.phase, emptyLabel)}
            <span class="heart-badge own" data-lane-heart="self">♥ ${collectionComplete ? 0 : selfBattle?.hearts ?? bottom.slots[index]!.hearts}</span>
          </div>
          <div class="pair-action-space">
            ${view.phase === "preparation" && selfIsDuelist && !self.locked && index === view.activeLane ? `
              ${view.activeLane < 2 ? `<div class="heart-controls">
                <button data-heart="1" data-index="${index}" ${!self.slots[index]!.occupied || unassigned <= 0 ? "disabled" : ""}>+1</button>
                <button data-heart="${unassigned}" data-heart-mode="all" data-index="${index}" ${!self.slots[index]!.occupied || unassigned <= 0 ? "disabled" : ""}>ALL</button>
              </div>` : self.slots[index]!.occupied ? '<span class="forced-allocation">ALL REMAINING HP</span>' : ""}
            ` : ""}
          </div>
        </section>
      `;
    }).join("");
    const displayOpponentHp = sequencePending ? this.state.hpBeforeBattle(view, opponent.id) : opponent.hp;

    return `
      ${this.duelistBox(view, opponent, displayOpponentHp, "top")}
      <section class="battle-grid ${sequencePending ? "battle-sequence cards-pre-revealed" : ""}">${lanes}</section>
      ${this.duelistBox(view, bottom, displayBottomHp, "bottom")}
      <section class="player-console">
        ${selfIsDuelist && view.phase === "preparation" ? `<div class="self-summary"><span class="unassigned ${view.activeLane === 2 && !self.slots[2].occupied ? "danger" : "safe"}"><small>HP LEFT</small><strong>♥ ${unassigned}</strong></span></div>` : !selfIsDuelist ? '<div class="self-summary"><span><small>YOU ARE WATCHING</small><strong class="spectating-label">SPECTATOR</strong></span></div>' : ""}
        ${selfIsDuelist && view.phase !== "preparation" ? '<div class="self-summary" aria-hidden="true"></div>' : ""}
        <div class="hand-row">${view.self.hand.map((card) => new DrawViews(this.state).handCard(card, self, view)).join("")}</div>
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
                  : `Lock now to auto-play your leftmost card with all ${unassigned} remaining HP.`}</p>
            <button class="primary lock-button" data-action="lock" ${self.locked ? "disabled" : ""}>${self.locked ? "LOCKED" : `LOCK PAIR ${view.activeLane + 1}`}</button>
          </div>
        ` : view.phase === "preparation" ? `<p class="reveal-message">${escapeHtml(bottom.name)} and ${escapeHtml(opponent.name)} are committing pair ${view.activeLane + 1}.</p>` : view.phase === "battle" || sequencePending || view.phase === "finished" ? '<p class="reveal-message">Cards revealed. Resolving lanes, then collecting every card\'s hearts…</p>' : ""}
      </section>
    `;
  }

  boardCard(
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
}
