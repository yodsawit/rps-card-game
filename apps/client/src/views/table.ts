import { DUEL_ANIMATION_MS, BOT_TARGET_THINK_MS } from "@rps/game-core";
import type { MatchSnapshot, PublicPlayerView } from "@rps/protocol";
import { escapeHtml, cardFace } from "./components.js";
import type { MatchViewState, PokerPosition } from "./match-state.js";
import { cardCountDisplay } from "./player.js";
export class TableViews {
  constructor(private readonly state: MatchViewState) {}
  pokerPositions(view: MatchSnapshot): PokerPosition[] {
    const selfIndex = view.players.findIndex((player) => player.id === view.selfPlayerId);
    const seatCount = view.players.length;
    return view.players.map((player, index) => {
      const relativeIndex = (index - selfIndex + seatCount) % seatCount;
      const angle = Math.PI / 2 - relativeIndex * (Math.PI * 2 / seatCount);
      return { playerId: player.id, x: 50 + Math.cos(angle) * 44, y: 50 + Math.sin(angle) * 44 };
    });
  }

  targetTable(view: MatchSnapshot, self: PublicPlayerView, attacker: PublicPlayerView): string {
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
            <span class="poker-name-line"><strong>${escapeHtml(player.name)}${player.id === view.selfPlayerId ? " · YOU" : ""}</strong><span class="poker-card-source" data-card-source-player="${player.id}">${cardCountDisplay(player.handCount, "stack")}</span></span>
            ${stateLabel ? `<small>${stateLabel}</small>` : ""}
          </div>
          <b>&hearts; ${player.hp}</b>
        </${tag}>`;
    }).join("");
    const attackerPosition = positions.find((position) => position.playerId === attacker.id)!;
    const defenderPosition = defender ? positions.find((position) => position.playerId === defender.id)! : null;
    const botThinkDelay = attacker.isBot || livingCount === 2 ? BOT_TARGET_THINK_MS : 0;
    const introDuration = DUEL_ANIMATION_MS + botThinkDelay;
    const introElapsed = introActive && view.deadlineAt !== null
      ? Math.min(Math.max(introDuration - (view.deadlineAt - view.serverNow), 0), introDuration)
      : 0;
    const punchDelay = botThinkDelay - introElapsed;
    const punch = defender && defenderPosition ? `
      <div class="versus-punch" aria-label="${escapeHtml(attacker.name)} challenges ${escapeHtml(defender.name)}"
        style="--from-x:${attackerPosition.x.toFixed(2)}%;--from-y:${attackerPosition.y.toFixed(2)}%;--to-x:${defenderPosition.x.toFixed(2)}%;--to-y:${defenderPosition.y.toFixed(2)}%;--intro-delay:${punchDelay}ms">
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

  finalTable(view: MatchSnapshot): string {
    const outcome = view.outcome!;
    const positions = this.pokerPositions(view);
    const sequenceKey = this.state.outcomeKey(view);
    const sequenceElapsed = this.state.activeOutcomeSequence?.key === sequenceKey
      ? this.state.clock.elapsed() - this.state.activeOutcomeSequence.startedAt
      : 0;
    const crownedIds = outcome.kind === "winner" && outcome.winnerId
      ? [outcome.winnerId]
      : view.battle
        ? [...view.battle.duelistIds]
        : view.players.slice(-2).map((player) => player.id);
    const crownDelay = this.state.outcomeCrownDelay(view) - sequenceElapsed;
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
            <span class="poker-name-line"><strong>${escapeHtml(player.name)}${player.id === view.selfPlayerId ? " · YOU" : ""}</strong><span class="poker-card-source" data-card-source-player="${player.id}">${cardCountDisplay(player.handCount, "stack")}</span></span>
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

  showdownCards(view: MatchSnapshot, positions: PokerPosition[], sequenceElapsed: number): string {
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
}
