import { advancePreparationPair, finalizeDiscards, type CardSymbol, type DrawChangeMemory, type RandomSource } from "@rps/game-core";
import type { ServerActionSource } from "./server-log.js";
import type { GameStudyEventType } from "./study-log.js";
import type { Room } from "./types.js";

import { recordBattleLog } from "./match-journal.js";

/** Authoritative round transitions and the public two-round memory. */
export class RoundTransitions {
  constructor(
    private readonly random: RandomSource,
    private readonly study: (room: Room, now: number, type: GameStudyEventType, data: Record<string, unknown>, round?: number) => void,
    private readonly audit: (room: Room, now: number, type: string, source: ServerActionSource, actorId: string | null, data: Record<string, unknown>, round?: number) => void
  ) {}
  advancePreparation(room: Room, now: number): void {
    const game = room.game!;
    const completedLane = game.preparationLane;
    const duelistIds = [game.attackerId, game.defenderId!] as const;
    const handsBeforeDrawDiscard = new Map(game.players.map((player) => [
      player.id,
      player.hand.map((card) => card.symbol)
    ]));
    const battle = advancePreparationPair(game, now, this.random);
    const revealedSides = battle
      ? battle.lanes[completedLane]!.sides.map((side) => ({
          playerId: side.playerId,
          symbol: side.card?.symbol ?? null,
          hearts: side.hearts
        }))
      : duelistIds.map((playerId) => {
          const player = game.players.find((candidate) => candidate.id === playerId)!;
          const slot = player.slots[completedLane]!;
          return {
            playerId,
            symbol: player.hand.find((card) => card.id === slot.cardId)?.symbol ?? null,
            hearts: slot.hearts
          };
        });
    this.study(room, now, "pair_revealed", { lane: completedLane, sides: revealedSides });
    if (battle) {
      recordBattleLog(room, battle, handsBeforeDrawDiscard);
      this.study(room, now, "battle_resolved", {
        duelistIds: battle.duelistIds,
        lanes: battle.lanes.map((lane) => ({
          lane: lane.index,
          tripleOverride: lane.tripleOverride,
          sides: lane.sides.map((side) => ({
            playerId: side.playerId,
            symbol: side.card?.symbol ?? null,
            hearts: side.hearts,
            result: side.result,
            receivedHp: side.receivedHp
          }))
        })),
        unassignedLost: battle.unassignedLost,
        noLoss: battle.noLoss,
        resultingHp: battle.resultingHp,
        eliminatedIds: battle.eliminatedIds
      });
    }
    if (!battle || room.lastObservedBattleRound === battle.round) return;
    for (const playerId of battle.duelistIds) {
      const playerIndex = battle.duelistIds.indexOf(playerId);
      const symbols = battle.lanes.flatMap((lane) => {
        const symbol = lane.sides.find((side) => side.playerId === playerId)?.card?.symbol;
        return symbol ? [symbol] : [];
      });
      const tripleSymbol = symbols.length === 3 && symbols.every((symbol) => symbol === symbols[0])
        ? symbols[0]!
        : null;
      const previousObservation = room.knownHands.get(playerId);
      const hpBeforeBattle = battle.lanes.reduce((total, lane) => {
        return total + (lane.sides.find((side) => side.playerId === playerId)?.hearts ?? 0);
      }, 0) + battle.unassignedLost[playerIndex]!;
      room.knownHands.set(playerId, {
        symbols,
        observedRound: battle.round,
        tripleSymbol,
        consecutiveTripleUses: tripleSymbol
          ? previousObservation?.tripleSymbol === tripleSymbol
            ? previousObservation.consecutiveTripleUses + 1
            : 1
          : 0,
        playedHands: [
          ...(previousObservation?.playedHands ?? []),
          {
            round: battle.round,
            handCount: room.game!.players.find((player) => player.id === playerId)!.hand.length,
            symbols: battle.lanes.map((lane) =>
              lane.sides.find((side) => side.playerId === playerId)?.card?.symbol ?? null
            ) as [CardSymbol | null, CardSymbol | null, CardSymbol | null],
            hearts: battle.lanes.map((lane) =>
              lane.sides.find((side) => side.playerId === playerId)?.hearts ?? 0
            ) as [number, number, number]
          }
        ].slice(-2),
        drawChanges: previousObservation?.drawChanges ?? []
      });
      room.recentBattleLosses.set(playerId, {
        hpLost: Math.max(hpBeforeBattle - battle.resultingHp[playerIndex]!, 0),
        lossRatio: hpBeforeBattle > 0
          ? Math.max(hpBeforeBattle - battle.resultingHp[playerIndex]!, 0) / hpBeforeBattle
          : 0,
        battleRound: battle.round
      });
    }
    room.lastObservedBattleRound = battle.round;
  }

  finalizeRoomDiscards(room: Room, now: number): void {
    const game = room.game!;
    const resolvedRound = game.round;
    const duelists = game.players.filter((player) =>
      player.id === game.attackerId || player.id === game.defenderId
    );
    const publicChanges: Array<DrawChangeMemory & { playerId: string }> = [];
    const shuffleLog = duelists.map((player) => ({
      playerId: player.id,
      drawnCards: player.drawnCardIds.map((cardId) =>
        player.hand.find((card) => card.id === cardId)!.symbol
      ),
      discardedCards: player.discardSelection.map((cardId) =>
        player.hand.find((card) => card.id === cardId)!.symbol
      ),
      bonusDraw: player.noLossBonus,
      paidExtraDraw: player.extraDrawPurchased
    }));
    for (const player of duelists) {
      const memory = room.knownHands.get(player.id);
      const change: DrawChangeMemory = {
        round: game.round,
        drawnCount: player.drawnCardIds.length,
        discardedCount: player.requiredDiscards,
        handDelta: player.drawnCardIds.length - player.requiredDiscards,
        bonusDraw: player.noLossBonus,
        paidDraw: player.extraDrawPurchased
      };
      publicChanges.push({ playerId: player.id, ...change });
      if (memory) memory.drawChanges = [...memory.drawChanges, change].slice(-2);
    }
    this.audit(room, now, "discards_committed", "system", null, {
      players: duelists.map((player) => ({
        playerId: player.id,
        handBefore: player.hand.map((card) => ({ ...card })),
        discardedCards: player.discardSelection.map((cardId) =>
          player.hand.find((card) => card.id === cardId)!
        ),
        drawnCards: player.drawnCardIds.map((cardId) =>
          player.hand.find((card) => card.id === cardId)!
        ),
        requiredDiscards: player.requiredDiscards,
        paidDraw: player.extraDrawPurchased,
        bonusDraw: player.noLossBonus
      }))
    }, resolvedRound);
    const outcome = finalizeDiscards(game, now, this.random);
    const roundLog = room.matchLog.find((entry) => entry.round === resolvedRound);
    for (const decision of shuffleLog) {
      const playerLog = roundLog?.players.find((player) => player.playerId === decision.playerId);
      const player = game.players.find((candidate) => candidate.id === decision.playerId)!;
      if (!playerLog) continue;
      playerLog.drawnCards = decision.drawnCards;
      playerLog.discardedCards = decision.discardedCards;
      playerLog.bonusDraw = decision.bonusDraw;
      playerLog.paidExtraDraw = decision.paidExtraDraw;
      playerLog.handCountAfter = player.hand.length;
      playerLog.hpAfter = player.hp;
      playerLog.eliminatedAfter = player.eliminated;
    }
    this.study(room, now, "shuffle_resolved", {
      players: publicChanges.map((change) => ({
        ...change,
        resultingHandCount: game.players.find((player) => player.id === change.playerId)!.hand.length,
        resultingHp: game.players.find((player) => player.id === change.playerId)!.hp
      })),
      outcome
    }, resolvedRound);
  }

}
