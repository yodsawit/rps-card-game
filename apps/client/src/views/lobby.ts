import type { LobbySnapshot } from "@rps/protocol";
import { escapeHtml } from "./components.js";
export function renderLobby(view: LobbySnapshot): string {
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
  return `
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
}
