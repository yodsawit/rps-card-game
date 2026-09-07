# RPS

A 2–6 player Rock-Paper-Scissors card game with public HP wagers, sequential
face-down pair choices and reveals, optional HP-paid draws, hand growth,
triples, and five-of-a-kind showdowns. Players attack clockwise and may choose
any living opponent; computer seats can be added from the room lobby.
The host chooses a 20-second, 30-second, or unlimited timer shared by target
selection, each card/HP pair, and discarding. Every selected matchup has a
server-synchronized two-second table intro before preparation begins.
Locking any empty pair automatically commits the leftmost available card with
0 HP. Explicitly placing the final card, or reaching it by timeout, still puts
all remaining HP on that final pair.

Hosts can add a basic heuristic bot, the exact advanced GTO bot, or the learned
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
not as an amount the opponent could still increase.

During discard, ARC has a 30% collection mode: when the available cards permit
a five-card `4+1` hand, it keeps four matching cards plus the symbol they beat
(for example, `RRRRS`) instead of its usual `3+1+1` preference. GTO estimates
the remaining deck from the same jointly sampled public-information hand model
used by its other decisions. It compares skipping with the probability-weighted
value of every possible paid draw, charges the real one-HP cost, and evaluates
the resulting discard choices with the same Bayesian maximin hand model.
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
so public Socket.IO connections need no separate URL or CORS setup. Study-file
logging is disabled because a free service has ephemeral storage.

Free services can sleep after an idle period, and every in-memory room is lost
when the process sleeps, restarts, or redeploys. This configuration is suitable
for public hobby play, not durable production rooms.

When Render auto-deploy is enabled for the repository, a push to `main`
automatically builds the commit and restarts the service. Existing in-memory
rooms are lost during that restart.

## Structure

- `packages/game-core`: deterministic rules and computer opponent
- `packages/protocol`: privacy-safe client/server message types
- `apps/server`: room, timer, reconnection, and match authority
- `apps/client`: Vite, Phaser effects, and the game interface
