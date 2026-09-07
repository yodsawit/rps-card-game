# RPS

A 2–6 player Rock-Paper-Scissors card game with public HP wagers, sequential
face-down pair choices and reveals, optional HP-paid draws, hand growth,
triples, and five-of-a-kind showdowns. Players attack clockwise and may choose
any living opponent; computer seats can be added from the room lobby.
The host chooses a 20-second, 30-second, or unlimited timer shared by target
selection, each card/HP pair, and discarding. Every selected matchup has a
server-synchronized two-second table intro before preparation begins, plus a
one-second pause before automatic or bot selections.
Locking any empty pair automatically commits the leftmost available card with
0 HP on the first two pairs. The final pair always receives all remaining HP,
including when an empty lock automatically chooses the leftmost card.
If the deck runs out, remaining draws are skipped. Discard requirements use
the cards actually drawn; no draw means no discard. Mandatory draws are dealt
in attacker-first order, without recycling pending discards early.

Hosts can add a basic heuristic bot, the advanced GTO bot, or the learned
PPO bot. Advanced bots
share the last two public played-hand and draw-count observations, sample joint
hidden-hand/deck states from that history, enumerate every legal remaining
symbol sequence (up to Rock/Paper/Scissors cubed) and whole-HP split, and solve
a maximin mixed strategy without heuristic matchup bonuses. The bot uses only
the current action from that solution and solves the remaining game again after
each public reveal. Its battle utility is HP difference while the players are
near parity; when its starting HP is at most half of the opponent's, surviving
HP is weighted 1.5x so a trailing bot becomes more protective without becoming
fully passive. A locked opponent's visible current-lane HP is modeled as exact,
not as an amount the opponent could still increase. The matrix solution is
exact to numerical tolerance for the sampled model, not an exact equilibrium
of the full hidden-information game. Sampling and future opponent behavior
remain modeling assumptions; decision logs report `historyFallbackRate` when
sampling must relax historical constraints.

During discard, ARC has a 30% collection mode: when the available cards permit
a five-card `4+1` hand, it keeps four matching cards plus the symbol they beat
(for example, `RRRRS`) instead of its usual `3+1+1` preference. GTO estimates
the remaining deck from the same jointly sampled public-information hand model
used by its other decisions. It compares skipping with the probability-weighted
value of every possible paid draw, charges the real one-HP cost, and evaluates
the resulting discard choices with the same HP-based Bayesian maximin utility
as battle decisions. Guaranteed five-of-a-kind receives a terminal reward above
the largest nonterminal HP payoff.
ARC always purchases the optional draw when it holds four matching cards and
the purchase is legal. For every bot matchup, all mandatory and bonus cards are
drawn first, every bot then resolves its optional purchase, and only afterward
may the first bot select any discards.

## Development

```powershell
npm.cmd install
npm.cmd test
npm.cmd run dev
```

On macOS or Linux, use the commands without the `.cmd` suffix:

```sh
npm install
npm test
npm run dev
```

The client runs at `http://localhost:5173` and proxies Socket.IO traffic to the
authoritative server at `http://localhost:3001`. Other devices on the same LAN
must open the host computer's address (for example,
`http://192.168.1.20:5173`), not their own `localhost`.

## Study logs

The server appends newline-delimited JSON game events to
`game-logs/games.jsonl`. Advanced decision records include sampled opponent-hand
counts and percentages, predicted next-symbol percentages, enumerated plan
counts, the mixed current card/HP strategy, and the selected action. The same
file records targets, public pair reveals, battle results, public draw/discard
counts, and final standings. It excludes session tokens, socket IDs, deck order,
and hidden card IDs.

The learned bot is deployed separately as `RL`. It samples the mixed policy
selected by the fixed-seed promotion evaluation, so it does not replace either
ARC or GTO. The server uses a synchronous JSON representation of the same
weights used by the verified ONNX export; a parity test guards against weight
conversion drift.

Set `RPS_STUDY_LOG` to another file path to relocate the log, or set it to
`off` to disable logging.
Both file loggers write asynchronously, cap queued data at 4 MiB, and rotate
10 MiB files with five retained backups. Queue overflow or disk failures are
reported to stderr; logs are diagnostic, not a guaranteed durable ledger.

### Private server audit log

The server also writes `game-logs/server-actions.jsonl` for detailed match
analysis. This server-only JSONL records the exact initial deal and later draws,
plus every card placement, heart commit, lock, timeout, discard selection,
committed discard, reveal, and outcome. Each entry includes the complete
authoritative match state, including hidden hands and deck order.

This file is intentionally never included in Socket.IO snapshots, bot memory,
or any HTTP route, so neither players nor bots can read it. Treat it as
sensitive match data. Set `RPS_SERVER_LOG` to another server-local path to
relocate it, or set it to `off` to disable it.

## Self-play training

The [Colab self-play notebook](training/RPS_Self_Play_Colab.ipynb) fine-tunes a
shared masked PPO policy against self-play, production-aligned ARC, a fast
Bayesian/maximin GTO-style opponent, and a frozen-policy league. It cycles
through 2–6-seat deck distributions and oversamples rare collection/draw
states. The local promotion gate compares old and candidate policies over at
least 1,000 fixed-seed games each against the real TypeScript ARC and GTO,
restoring the deployed model if the candidate fails. See
[the training guide](training/README.md) before promotion.

The promoted model, external ONNX data, model specification, and evaluation
reports live together in `apps/server/models`. Both `rps_policy.onnx` and
`rps_policy.onnx.data` are required when loading the ONNX model.

## Public deployment

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/yodsawit/rps-card-game)

The root `render.yaml` deploys the built client and Node/Socket.IO server as one
free Render web service in Singapore. Render supplies `PORT`; the server binds
to `0.0.0.0`, exposes `/api/health`, and serves the client from the same origin
so public Socket.IO connections need no separate URL or CORS setup. Both file
logs are disabled because a free service has ephemeral storage.

Free services can sleep after an idle period, and every in-memory room is lost
when the process sleeps, restarts, or redeploys. This configuration is suitable
for public hobby play, not durable production rooms.

The Blueprint requests deployment after CI checks pass. This applies when the
service is connected to the Git provider and its Blueprint settings are synced;
an existing manually configured service does not change merely by editing this
file. Public-URL-only services may require manual deployment. Existing rooms
are lost during a restart.

## Operational safeguards and checks

Socket requests require valid payloads and acknowledgements where specified.
Resuming a seat revokes control from its previous connection. Abandoned rooms
expire, and rematches omit departed players. The server limits connections,
room creation, packet size, and action rates; these are abuse safeguards, not
authentication or a distributed DDoS defense. Production browser origins must
match the server host or the comma-separated `RPS_ALLOWED_ORIGINS` allowlist.
IP quotas use the direct peer address; a reverse proxy can share that quota
across clients. Review limits for your hosting topology before wider rollout.

Bot calculations run in at most two isolated workers with revision checks so
stale results cannot overwrite newer player actions. Worker resource failures
or calculations exceeding 12 seconds stop the affected match with an error
result, not the entire server. The solver also has an iteration guard; it does
not silently substitute a heuristic when mathematical solving fails.

Run `npm run typecheck`, `npm test`, `npm run test:ui`, and `npm run build`.
Browser tests use installed Edge on Windows and Playwright Chromium on Linux
(`npx playwright install chromium`); override with `RPS_BROWSER_EXECUTABLE`.
GitHub Actions also runs the Python training/checkpoint regressions.

## Structure

- `packages/game-core`: deterministic rules and computer opponent
- `packages/protocol`: privacy-safe client/server message types
- `apps/server`: room, timer, reconnection, and match authority
- `apps/client`: Vite, Phaser effects, and the game interface

### Module boundaries

- Client: `main.ts` wires browser dependencies; `application.ts` handles socket/input coordination. `views/` renders home, lobby, table, battle, draw and logs. `presentation/match.ts` owns animation timers and cleanup; `styles/` keeps the explicit CSS cascade order. Browser tests import the application factory without rewriting its source.
- Server: `room-manager.ts` is the command facade. `room-sessions.ts` owns reconnect identity, `round-transitions.ts` advances rounds and public memory, and `match-journal.ts` builds the post-match log.
- Bots: `bot-turn.ts` coordinates decisions on the authoritative server. Workers receive only typed inputs from `bot-decisions.ts`, never room credentials, hidden opponent hands, deck order or private logs. Revision checks reject superseded results; accepted buy/skip decisions survive restarts. All bot purchase decisions precede bot discard selection.
- GTO: `game-core/src/advanced/` separates sampling, plans, linear programming, utility, pair and retention decisions. `advanced-ai.ts` preserves the public exports. Rules and GTO use the shared combat payout kernel.
- Training: `training.self_play` remains the CLI and compatibility import surface; model, rollout, PPO, evaluation and artifact export are separate modules. `policy-schema.json` and shared observation fixtures guard Python/TypeScript compatibility. Neither this refactor nor a smoke training run replaces deployed policy weights.
