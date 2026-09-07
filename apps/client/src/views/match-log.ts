import type { CardSymbol } from "@rps/game-core";
import type { MatchSnapshot, MatchRoundLogView } from "@rps/protocol";
import { escapeHtml, cardFace, symbolLabel } from "./components.js";
export class MatchLogView {
  selectedLogRound: number | null = null;
  selectedLogTab: "resolve" | "cards" = "resolve";
  render(view: MatchSnapshot): string {
    const requestedIndex = view.matchLog.findIndex((entry) => entry.round === this.selectedLogRound);
    const selectedIndex = requestedIndex >= 0 ? requestedIndex : 0;
    const selected = view.matchLog[selectedIndex];
    const atFirst = selectedIndex <= 0;
    const atLast = selectedIndex >= view.matchLog.length - 1;
    const selectedAttacker = selected ? this.logPlayerName(view, selected.attackerId) : "Unknown player";
    const selectedDefender = selected?.defenderId ? this.logPlayerName(view, selected.defenderId) : "No opponent";
    return `
      <div class="result-scrim log-scrim">
        <dialog id="match-log-dialog" class="match-log-card" aria-label="Match log">
          <header class="match-log-header">
            <h2>ROUND <strong>${selected?.round ?? "-"}</strong></h2>
            <p class="match-log-matchup"><span>${escapeHtml(selectedAttacker)}</span><i>challenged</i><span>${escapeHtml(selectedDefender)}</span></p>
            <button class="icon-button" data-action="close-log" aria-label="Close match log"><span class="log-close-mark" aria-hidden="true"></span></button>
          </header>
          <div class="match-log-body">
            <div class="log-round-detail">
              ${selected ? this.matchRoundDetail(view, selected) : '<p class="log-empty">No recorded rounds.</p>'}
            </div>
          </div>
          <nav class="log-round-nav" aria-label="Travel through rounds">
            ${this.logRoundNavButton("first", "FIRST ROUND", atFirst)}
            ${this.logRoundNavButton("previous", "PREVIOUS ROUND", atFirst)}
            ${this.logRoundNavButton("next", "NEXT ROUND", atLast)}
            ${this.logRoundNavButton("last", "LAST ROUND", atLast)}
          </nav>
        </dialog>
      </div>`;
  }

  private matchRoundDetail(view: MatchSnapshot, entry: MatchRoundLogView): string {
    const duelists = [...entry.players].filter((player) => player.role !== "idle").sort((left, right) => {
      const order = { attacker: 0, defender: 1, idle: 2 } as const;
      return order[left.role] - order[right.role];
    });
    const idlePlayers = entry.players.filter((player) => player.role === "idle");
    return `
      <nav class="log-tabs" aria-label="Round information">
        <button class="${this.selectedLogTab === "resolve" ? "active" : ""}" data-log-tab="resolve" aria-selected="${this.selectedLogTab === "resolve"}">RESOLVE</button>
        <button class="${this.selectedLogTab === "cards" ? "active" : ""}" data-log-tab="cards" aria-selected="${this.selectedLogTab === "cards"}">PLAYER CARDS</button>
      </nav>
      ${this.selectedLogTab === "cards"
        ? this.matchRoundHands(view, entry)
        : `<div class="log-resolve-board">
            ${duelists.map((player, index) => `${index === 1 ? '<div class="log-resolve-versus"><span>VS</span></div>' : ""}${this.matchResolvePlayer(view, player)}`).join("")}
            ${idlePlayers.length > 0 ? `<div class="log-idle-strip"><small>NOT IN THIS DUEL</small>${idlePlayers.map((player) => `<span>${escapeHtml(this.logPlayerName(view, player.playerId))} <i>&hearts; ${player.hpAfter}</i></span>`).join("")}</div>` : ""}
          </div>`}`;
  }

  private matchResolvePlayer(view: MatchSnapshot, player: MatchRoundLogView["players"][number]): string {
    const hasBattle = player.playedCards.some((symbol) => symbol !== null);
    const hasShuffle = player.drawnCards.length > 0 || player.discardedCards.length > 0 || player.paidExtraDraw;
    const hpDelta = player.hpAfter - player.hpBefore;
    const handDelta = player.handCountAfter - player.handCountBefore;
    return `
      <article class="log-resolve-player ${player.role}">
        <header>
          <small>${player.role.toUpperCase()}</small>
          <strong>${escapeHtml(this.logPlayerName(view, player.playerId))}</strong>
          <span class="log-player-hp"><b>&hearts;</b> ${player.hpBefore}${this.logSignedDelta(hpDelta, "hp")}</span>
          <span class="log-player-status">
            ${player.eliminatedAfter ? '<em>OUT</em>' : `<span class="log-player-hand">HAND ${player.handCountBefore}${this.logSignedDelta(handDelta, "hand")}</span>`}
          </span>
        </header>
        <section class="log-resolve-cards">
          ${player.playedCards.map((symbol, index) => {
            const result = player.results[index];
            const receivedHp = player.receivedHp[index] ?? 0;
            return `
              <div class="log-battle-card ${result ?? "pending"}">
                <div class="log-card-stake">
                  ${this.logCardIcon(symbol, true)}
                </div>
                <span class="log-card-heart"><b>&hearts;</b> ${player.hearts[index]}</span>
                <footer>
                  <strong>${result?.toUpperCase() ?? "NOT RESOLVED"}</strong>
                  ${receivedHp > 0 ? `<em>+${receivedHp} HP</em>` : ""}
                </footer>
              </div>`;
          }).join("")}
        </section>
        <section class="log-resolve-shuffle">
          <div>
            <strong>${player.paidExtraDraw ? "BOUGHT +1 CARD" : "NO EXTRA CARD"}</strong>
            ${player.bonusDraw ? `<span>${player.drawnCards.length - Number(player.paidExtraDraw) >= 2 ? "NO-LOSS BONUS +1" : "NO-LOSS BONUS UNAVAILABLE"}</span>` : ""}
          </div>
          <div>
            <p class="log-section-label">DRAWN</p>
            <span class="log-card-row">${player.drawnCards.length > 0 ? player.drawnCards.map((symbol) => this.logCardIcon(symbol)).join("") : `<i>${hasBattle ? "NONE" : "ROUND ENDED"}</i>`}</span>
          </div>
          <div>
            <p class="log-section-label">DISCARDED</p>
            <span class="log-card-row">${player.discardedCards.length > 0 ? player.discardedCards.map((symbol) => this.logCardIcon(symbol)).join("") : `<i>${hasShuffle ? "NONE" : "NO RESHUFFLE"}</i>`}</span>
          </div>
        </section>
      </article>`;
  }

  private matchRoundHands(view: MatchSnapshot, entry: MatchRoundLogView): string {
    const playersBySeat = [...entry.players].sort((left, right) => {
      const leftSeat = view.players.find((player) => player.id === left.playerId)?.seatIndex ?? 99;
      const rightSeat = view.players.find((player) => player.id === right.playerId)?.seatIndex ?? 99;
      return leftSeat - rightSeat;
    });
    return `
      <section class="log-hand-table">
        <header>
          <div><strong>PLAYER HANDS</strong><small>Before battle</small></div>
        </header>
        <div class="log-hand-columns" aria-hidden="true"><span>PLAYER</span>${[1, 2, 3, 4, 5].map((column) => `<span>CARD ${column}</span>`).join("")}</div>
        ${playersBySeat.map((player) => {
          const cards = [...player.handBeforeDrawDiscard];
          return `
            <div class="log-hand-row">
              <div class="log-hand-player">
                <strong>${escapeHtml(this.logPlayerName(view, player.playerId))}</strong>
                <span class="log-hand-role">${player.role === "idle" ? "NOT IN DUEL" : player.role.toUpperCase()}</span>
                <span class="log-hand-hp"><b>&hearts;</b> ${player.hpBefore}</span>
              </div>
              ${[0, 1, 2, 3, 4].map((index) => `<div class="log-hand-cell">${this.logCardIcon(cards[index] ?? null, true)}</div>`).join("")}
            </div>`;
        }).join("")}
      </section>`;
  }

  private logRoundNavButton(action: "first" | "previous" | "next" | "last", label: string, disabled: boolean): string {
    const backwards = action === "first" || action === "previous";
    const edge = action === "first" || action === "last";
    return `<button class="log-nav-button ${backwards ? "back" : "forward"} ${edge ? "edge" : "step"}" data-log-nav="${action}" aria-label="${label}" title="${label}" ${disabled ? "disabled" : ""}><i></i>${edge ? "<b></b>" : ""}</button>`;
  }

  private logPlayerName(view: MatchSnapshot, playerId: string): string {
    return view.players.find((player) => player.id === playerId)?.name ?? "Unknown player";
  }

  private logSignedDelta(delta: number, kind: "hp" | "hand"): string {
    if (delta === 0) return "";
    const direction = delta > 0 ? "gain" : "loss";
    return `<i class="log-delta ${kind} ${direction}">${delta > 0 ? "+" : "&minus;"}${Math.abs(delta)}</i>`;
  }

  private logCardIcon(symbol: CardSymbol | null, large = false): string {
    if (!symbol) return `<span class="log-card-icon empty ${large ? "large" : ""}" aria-label="No card">&mdash;</span>`;
    return `<span class="log-card-icon face ${large ? "large" : ""}" title="${symbolLabel(symbol)}" aria-label="${symbolLabel(symbol)}">${cardFace(symbol, true)}</span>`;
  }
}
