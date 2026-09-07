import type { BattleSummary, CardSymbol } from "@rps/game-core";
import type { MatchRoundLogView } from "@rps/protocol";
import type { Room } from "./types.js";

export function ensureRoundLog(room: Room): MatchRoundLogView {
  const game = room.game!;
  const existing = room.matchLog.find((entry) => entry.round === game.round);
  if (existing) {
    existing.attackerId = game.attackerId;
    existing.defenderId = game.defenderId;
    for (const player of existing.players) {
      player.role = player.playerId === game.attackerId
        ? "attacker"
        : player.playerId === game.defenderId
          ? "defender"
          : "idle";
    }
    return existing;
  }
  const entry: MatchRoundLogView = {
    round: game.round,
    attackerId: game.attackerId,
    defenderId: game.defenderId,
    players: game.players.map((player) => ({
      playerId: player.id,
      role: player.id === game.attackerId
        ? "attacker"
        : player.id === game.defenderId
          ? "defender"
          : "idle",
      hpBefore: player.hp,
      hpAfter: player.hp,
      handCountBefore: player.hand.length,
      handCountAfter: player.hand.length,
      handBeforeDrawDiscard: player.hand.map((card) => card.symbol),
      playedCards: [null, null, null],
      hearts: [0, 0, 0],
      results: [null, null, null],
      receivedHp: [0, 0, 0],
      drawnCards: [],
      discardedCards: [],
      bonusDraw: false,
      paidExtraDraw: false,
      eliminatedAfter: player.eliminated
    }))
  };
  room.matchLog.push(entry);
  return entry;
}

export function recordBattleLog(
  room: Room,
  battle: BattleSummary,
  handsBeforeDrawDiscard: ReadonlyMap<string, CardSymbol[]>
): void {
  const entry = ensureRoundLog(room);
  const game = room.game!;
  for (const playerLog of entry.players) {
    const player = game.players.find((candidate) => candidate.id === playerLog.playerId)!;
    const battleIndex = battle.duelistIds.indexOf(player.id);
    const handBefore = handsBeforeDrawDiscard.get(player.id) ?? [];
    playerLog.handCountBefore = handBefore.length;
    playerLog.handCountAfter = player.hand.length;
    playerLog.handBeforeDrawDiscard = [...handBefore];
    playerLog.hpAfter = player.hp;
    playerLog.eliminatedAfter = player.eliminated;
    if (battleIndex < 0) continue;
    const sides = battle.lanes.map((lane) => lane.sides.find((side) => side.playerId === player.id)!);
    playerLog.hpBefore = sides.reduce((total, side) => total + side.hearts, 0)
      + battle.unassignedLost[battleIndex]!;
    playerLog.hpAfter = battle.resultingHp[battleIndex]!;
    playerLog.playedCards = sides.map((side) => side.card?.symbol ?? null) as typeof playerLog.playedCards;
    playerLog.hearts = sides.map((side) => side.hearts) as typeof playerLog.hearts;
    playerLog.results = sides.map((side) => side.result) as typeof playerLog.results;
    playerLog.receivedHp = sides.map((side) => side.receivedHp) as typeof playerLog.receivedHp;
  }
}
