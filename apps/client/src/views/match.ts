import type { MatchSnapshot, PublicPlayerView } from "@rps/protocol";
import { escapeHtml } from "./components.js";
import { TableViews } from "./table.js";
import { BattleViews } from "./battle.js";
import { DrawViews } from "./draw.js";
import type { MatchViewState } from "./match-state.js";
export type { MatchViewState } from "./match-state.js";

/** Small composition facade; phase views do not own application state. */
export class MatchViews {
  private readonly table: TableViews;
  private readonly battle: BattleViews;
  private readonly draw: DrawViews;
  constructor(private readonly state: MatchViewState) {
    this.table = new TableViews(state);
    this.battle = new BattleViews(state);
    this.draw = new DrawViews(state);
  }
  pokerPositions(...args: Parameters<TableViews["pokerPositions"]>): ReturnType<TableViews["pokerPositions"]> { return this.table.pokerPositions(...args); }
  targetTable(...args: Parameters<TableViews["targetTable"]>): ReturnType<TableViews["targetTable"]> { return this.table.targetTable(...args); }
  finalTable(...args: Parameters<TableViews["finalTable"]>): ReturnType<TableViews["finalTable"]> { return this.table.finalTable(...args); }
  showdownCards(...args: Parameters<TableViews["showdownCards"]>): ReturnType<TableViews["showdownCards"]> { return this.table.showdownCards(...args); }
  handCard(...args: Parameters<DrawViews["handCard"]>): ReturnType<DrawViews["handCard"]> { return this.draw.handCard(...args); }
  discardPanel(...args: Parameters<DrawViews["discardPanel"]>): ReturnType<DrawViews["discardPanel"]> { return this.draw.discardPanel(...args); }
  duelistBox(...args: Parameters<BattleViews["duelistBox"]>): ReturnType<BattleViews["duelistBox"]> { return this.battle.duelistBox(...args); }
  spectatorPanel(...args: Parameters<BattleViews["spectatorPanel"]>): ReturnType<BattleViews["spectatorPanel"]> { return this.battle.spectatorPanel(...args); }
  battleBoard(...args: Parameters<BattleViews["battleBoard"]>): ReturnType<BattleViews["battleBoard"]> { return this.battle.battleBoard(...args); }
  boardCard(...args: Parameters<BattleViews["boardCard"]>): ReturnType<BattleViews["boardCard"]> { return this.battle.boardCard(...args); }
  resultOverlay(view: MatchSnapshot, self: PublicPlayerView): string {
    if (this.state.matchLogOpen) return this.state.log.render(view);
    const won = view.outcome?.winnerId === self.id;
    const draw = view.outcome?.kind === "draw";
    const winner = view.players.find((player) => player.id === view.outcome?.winnerId);
    const title = draw ? "DRAW" : won ? "VICTORY" : "DEFEAT";
    const detail = view.outcome?.reason === "error"
      ? "This match stopped because of a server error. You can request a rematch."
      : view.outcome?.reason === "showdown"
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
        <dialog id="result-dialog" aria-label="Match result" class="result-card ${draw ? "draw" : won ? "win" : "loss"}">
          <p class="eyebrow">MATCH COMPLETE</p>
          <h2>${title}</h2>
          <p>${detail}</p>
          <div class="result-actions">
            <button class="primary" data-action="rematch" ${self.rematchRequested ? "disabled" : ""}>${self.rematchRequested ? "REMATCH REQUESTED" : "REQUEST REMATCH"}</button>
            <button class="secondary" data-action="view-log" ${view.matchLog.length === 0 ? "disabled" : ""}>VIEW LOG</button>
            <button class="ghost" data-action="leave">LEAVE TABLE</button>
          </div>
        </dialog>
      </div>
    `;
  }
}
