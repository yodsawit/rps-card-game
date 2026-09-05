import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { seededRandom, type BotDifficulty } from "@rps/game-core";
import { RoomManager } from "../apps/server/src/room-manager.js";

interface RecordSummary {
  episodes: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  nonLossRate: number;
  averageRounds: number;
  seat0: { wins: number; losses: number; draws: number };
  seat1: { wins: number; losses: number; draws: number };
}

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`Missing ${name}.`);
  return value;
}

function evaluate(opponentDifficulty: BotDifficulty, episodes: number, baseSeed: number): RecordSummary {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let totalRounds = 0;
  const seats = [
    { wins: 0, losses: 0, draws: 0 },
    { wins: 0, losses: 0, draws: 0 }
  ];
  for (let episode = 0; episode < episodes; episode += 1) {
    const learnedSeat = episode % 2;
    const manager = new RoomManager(seededRandom(baseSeed + episode));
    let now = 1_000;
    const receipt = manager.createRoom("Temporary host", "evaluation", now);
    manager.addBot(
      receipt.roomCode,
      receipt.playerId,
      ++now,
      learnedSeat === 0 ? opponentDifficulty : "learned"
    );
    const room = manager.rooms.get(receipt.roomCode)!;
    const host = room.players[0]!;
    host.isBot = true;
    host.botDifficulty = learnedSeat === 0 ? "learned" : opponentDifficulty;
    host.name = learnedSeat === 0 ? "RL-1" : `${opponentDifficulty === "advanced" ? "GTO" : "ARC"}-1`;
    host.socketId = null;
    manager.startRoom(receipt.roomCode, receipt.playerId, ++now);

    for (let guard = 0; room.game!.phase !== "finished" && guard < 100; guard += 1) {
      const game = room.game!;
      if (game.phase !== "battle" || game.deadlineAt === null) {
        throw new Error(`Automated match stopped unexpectedly in ${game.phase}.`);
      }
      now = game.deadlineAt;
      manager.tick(now);
    }
    const game = room.game!;
    totalRounds += Math.min(game.round, 100);
    const learnedId = game.players[learnedSeat]!.id;
    if (game.phase !== "finished" || game.outcome?.winnerId === null) {
      draws += 1;
      seats[learnedSeat]!.draws += 1;
    } else if (game.outcome?.winnerId === learnedId) {
      wins += 1;
      seats[learnedSeat]!.wins += 1;
    } else {
      losses += 1;
      seats[learnedSeat]!.losses += 1;
    }
  }
  return {
    episodes,
    wins,
    losses,
    draws,
    winRate: wins / episodes,
    nonLossRate: (wins + draws) / episodes,
    averageRounds: totalRounds / episodes,
    seat0: seats[0]!,
    seat1: seats[1]!
  };
}

const episodes = Number.parseInt(argument("--episodes", "20"), 10);
const seed = Number.parseInt(argument("--seed", "151000000"), 10);
if (!Number.isInteger(episodes) || episodes < 2) throw new Error("--episodes must be at least 2.");
const report = {
  schemaVersion: 1,
  policy: "deployed rps_policy.weights.json",
  rules: "authoritative TypeScript RoomManager",
  episodesPerOpponent: episodes,
  seed,
  ARC: evaluate("basic", episodes, seed),
  GTO: evaluate("advanced", episodes, seed + 1_000_000)
};
const output = JSON.stringify(report, null, 2) + "\n";
const outputPath = process.argv.includes("--output") ? resolve(argument("--output")) : null;
if (outputPath) writeFileSync(outputPath, output, "utf8");
process.stdout.write(output);
