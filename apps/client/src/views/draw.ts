import type { Card } from "@rps/game-core";
import type { MatchSnapshot, PublicPlayerView } from "@rps/protocol";
import { escapeHtml, cardFace } from "./components.js";
import type { MatchViewState } from "./match-state.js";
export class DrawViews {
  constructor(private readonly state: MatchViewState) {}
  handCard(card: Card, self: PublicPlayerView, view: MatchSnapshot): string {
    const selectedForDiscard = view.self.discardSelection.includes(card.id);
    const selected = this.state.selectedCardId === card.id;
    const placedIndex = view.self.slotCardIds.indexOf(card.id);
    const isDuelist = self.id === view.attackerId || self.id === view.defenderId;
    const committed = view.phase === "preparation" && placedIndex >= 0;
    const canPrepare = view.phase === "preparation" && isDuelist && !self.locked && !committed;
    const canDiscard = view.phase === "discard" && isDuelist && !self.locked;
    const drawPending = view.phase === "discard"
      && view.self.drawnCardIds.includes(card.id)
      && !this.state.animatedDrawCards.has(this.state.drawCardKey(view, card.id));
    return `
      <button class="hand-card face ${card.symbol} ${selected ? "selected" : ""} ${selectedForDiscard ? "discard-selected" : ""} ${drawPending ? "draw-pending" : ""} ${committed ? "committed" : ""}"
        data-card-id="${card.id}" draggable="${canPrepare}" ${canPrepare || canDiscard ? "" : "disabled"}>
        ${cardFace(card.symbol)}
        ${committed ? `<span class="commit-mark">PAIR ${placedIndex + 1}</span>` : ""}
        ${selectedForDiscard ? '<span class="discard-mark">DISCARD</span>' : ""}
      </button>
    `;
  }

  discardPanel(view: MatchSnapshot, self: PublicPlayerView, opponent: PublicPlayerView): string {
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
}
