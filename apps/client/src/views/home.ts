export function renderHome(savedName: string): string {
  return `
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
}
