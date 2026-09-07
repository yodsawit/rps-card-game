import type { BotTurn } from "./bot-decisions.js";
import { makeLearnedInput } from "./learned-ai.js";
import { adjustSlotHearts, chooseAdvancedDraw, chooseAdvancedPair, chooseAdvancedTableDiscards, chooseAdvancedTarget, chooseComputerDiscards, chooseComputerPair, chooseComputerTarget, duelistsLocked, lockPlayer, publicPositions, purchaseExtraDraw, setCardPlacement, setDiscardSelection, shouldComputerPurchaseExtraDraw, type AdvancedPairChoice, type AdvancedShuffleView, type CardSymbol, type MatchState } from "@rps/game-core";
import { chooseLearnedDiscards, chooseLearnedPair, shouldLearnedPurchaseExtraDraw } from "./learned-ai.js";
import type { ServerActionSource } from "./server-log.js";
import type { GameStudyEventType } from "./study-log.js";
import type { Room } from "./types.js";

// A worker can be superseded by a human action between decisions. Do not reroll
// an already accepted buy/skip decision when its generator is restarted.
const drawDecisions = new WeakMap<MatchState, { round: number; players: Set<string> }>();

export interface BotTurnPorts {
  advancedShuffleView(room: Room, playerId: string): AdvancedShuffleView;
  selectRoomOpponent(room: Room, attackerId: string, targetId: string, now: number, source: "automatic" | "advanced_bot" | "learned_bot" | "basic_bot"): void;
  study(room: Room, now: number, type: GameStudyEventType, data: Record<string, unknown>): void;
  audit(room: Room, now: number, type: string, source: ServerActionSource, actorId: string | null, data: Record<string, unknown>): void;
  advancePreparation(room: Room, now: number): void;
  finalizeRoomDiscards(room: Room, now: number): void;
}

export function* computerTurn(room: Room, now: number, ports: BotTurnPorts): BotTurn {
  const game = room.game;
  if (!game) return;
  for (let guard = 0; guard < 30 && game.phase !== "finished"; guard += 1) {
    if (game.phase === "targeting") {
      if (game.defenderId !== null) return;
      const attacker = game.players.find((player) => player.id === game.attackerId)!;
      const living = game.players.filter((player) => !player.eliminated);
      if (living.length === 2) {
        const target = living.find((player) => player.id !== attacker.id)!;
        ports.selectRoomOpponent(room, attacker.id, target.id, now, "automatic");
        continue;
      }
      if (!attacker.isBot) return;
      const difficulty = room.players.find((player) => player.id === attacker.id)?.botDifficulty;
      const advanced = difficulty === "advanced";
      const learned = difficulty === "learned";
      const targetId = advanced || learned
        ? ((yield { method: "chooseAdvancedTarget", args: [{
            playerId: attacker.id,
            hand: attacker.hand,
            copiesPerSymbol: game.config.copiesPerSymbol,
            opponents: game.players.map((player) => {
              const observation = room.knownHands.get(player.id);
              return {
                id: player.id,
                eliminated: player.eliminated,
                handCount: player.hand.length,
                memory: {
                  playedHands: observation?.playedHands ?? [],
                  drawChanges: observation?.drawChanges ?? []
                }
              };
            })
          }, null] }) as ReturnType<typeof chooseAdvancedTarget>)
        : ((yield { method: "chooseComputerTarget", args: [
            attacker.id,
            attacker.hand,
            game.players.map((player) => {
              const observation = room.knownHands.get(player.id);
              return {
                id: player.id,
                hp: player.hp,
                eliminated: player.eliminated,
                ...(observation
                  ? {
                      knownSymbols: observation.symbols,
                      turnsSinceObserved: game.round - observation.observedRound
                    }
                  : {})
              };
            }),
            null
          ] }) as ReturnType<typeof chooseComputerTarget>);
      ports.selectRoomOpponent(
        room,
        attacker.id,
        targetId,
        now,
        advanced ? "advanced_bot" : learned ? "learned_bot" : "basic_bot"
      );
      continue;
    }

    if (game.phase === "preparation") {
      const duelists = game.players.filter((player) =>
        player.id === game.attackerId || player.id === game.defenderId
      );
      let acted = false;
      for (const bot of duelists.filter((player) => player.isBot && !player.locked)) {
        const opponent = duelists.find((player) => player.id !== bot.id)!;
        const observation = room.knownHands.get(opponent.id);
        const difficulty = room.players.find((player) => player.id === bot.id)?.botDifficulty;
        const advanced = difficulty === "advanced";
        const learned = difficulty === "learned";
        const opponentPositions = publicPositions(opponent.slots);
        const choice = learned
          ? ((yield { method: "learned", args: [makeLearnedInput(room, bot.id, "pair"), null] }) as ReturnType<typeof chooseLearnedPair>)
          : advanced
          ? ((yield { method: "chooseAdvancedPair", args: [{
              playerId: bot.id,
              hand: bot.hand,
              observerHand: bot.hand,
              hp: bot.hp,
              activeLane: game.preparationLane,
              ownSlots: bot.slots,
              opponentHp: opponent.hp,
              opponentId: opponent.id,
              opponentLocked: opponent.locked,
              opponentPositions,
              copiesPerSymbol: game.config.copiesPerSymbol,
              opponentHandCount: opponent.hand.length,
              memory: {
                playedHands: observation?.playedHands ?? [],
                drawChanges: observation?.drawChanges ?? []
              },
              currentRevealedSymbols: opponent.slots.slice(0, game.preparationLane).map((slot) =>
                opponent.hand.find((card) => card.id === slot.cardId)?.symbol ?? null
              ),
              tableOpponents: game.players
                .filter((player) => player.id !== bot.id && !player.eliminated)
                .map((player) => {
                  const playerMemory = room.knownHands.get(player.id);
                  return {
                    id: player.id,
                    handCount: player.hand.length,
                    memory: {
                      playedHands: playerMemory?.playedHands ?? [],
                      drawChanges: playerMemory?.drawChanges ?? []
                    },
                    ...(player.id === opponent.id
                      ? {
                          currentRevealedSymbols: player.slots
                            .slice(0, game.preparationLane)
                            .map((slot) => player.hand.find((card) => card.id === slot.cardId)?.symbol ?? null)
                        }
                      : {})
                  };
                })
            }, null] }) as ReturnType<typeof chooseAdvancedPair>)
          : ((yield { method: "chooseComputerPair", args: [{
              playerId: bot.id,
              hand: bot.hand,
              hp: bot.hp,
              activeLane: game.preparationLane,
              ownSlots: bot.slots,
              opponentPositions,
              ...(observation
                ? {
                    opponentKnownSymbols: observation.symbols,
                    turnsSinceObserved: game.round - observation.observedRound,
                    ...(observation.tripleSymbol && observation.consecutiveTripleUses >= 2
                      ? { opponentRepeatedTripleSymbol: observation.tripleSymbol }
                      : {})
                  }
                : {})
            }, null] }) as ReturnType<typeof chooseComputerPair>);
        if (advanced) {
          const advancedChoice = choice as AdvancedPairChoice;
          const ownHandCounts: Record<CardSymbol, number> = { rock: 0, paper: 0, scissors: 0 };
          for (const card of bot.hand) ownHandCounts[card.symbol] += 1;
          ports.study(room, now, "advanced_pair_decision", {
            playerId: bot.id,
            opponentId: opponent.id,
            lane: game.preparationLane,
            ownHp: bot.hp,
            opponentHp: opponent.hp,
            ownHandCounts,
            opponentHandCount: opponent.hand.length,
            opponentLocked: opponent.locked,
            publicOpponentPositions: opponentPositions,
            publicMemory: {
              playedHands: observation?.playedHands ?? [],
              drawChanges: observation?.drawChanges ?? []
            },
            choice: {
              symbol: bot.hand.find((card) => card.id === advancedChoice.cardId)!.symbol,
              hearts: advancedChoice.hearts,
              equilibriumValue: advancedChoice.equilibriumValue
            },
            model: advancedChoice.analysis
          });
        }
        setCardPlacement(game, bot.id, game.preparationLane, choice.cardId);
        ports.audit(room, now, "card_placed", "bot", bot.id, {
          slotIndex: game.preparationLane,
          card: bot.hand.find((card) => card.id === choice.cardId),
          difficulty
        });
        if (game.preparationLane < 2 && choice.hearts > 0) {
          adjustSlotHearts(game, bot.id, game.preparationLane, choice.hearts);
          ports.audit(room, now, "hearts_committed", "bot", bot.id, {
            slotIndex: game.preparationLane,
            delta: choice.hearts,
            hearts: bot.slots[game.preparationLane].hearts,
            difficulty
          });
        }
        lockPlayer(game, bot.id);
        ports.audit(room, now, "player_locked", "bot", bot.id, {
          phase: "preparation",
          lane: game.preparationLane,
          card: bot.hand.find((card) => card.id === bot.slots[game.preparationLane].cardId),
          hearts: bot.slots[game.preparationLane].hearts,
          difficulty
        });
        acted = true;
      }
      if (duelistsLocked(game)) {
        ports.advancePreparation(room, now);
        continue;
      }
      if (!acted) return;
      return;
    }

    if (game.phase === "discard") {
      let decisions = drawDecisions.get(game);
      if (!decisions || decisions.round !== game.round) {
        decisions = { round: game.round, players: new Set() };
        drawDecisions.set(game, decisions);
      }
      const duelists = game.players.filter((player) =>
        player.id === game.attackerId || player.id === game.defenderId
      );
      const actionableBots = duelists.filter((player) => player.isBot && !player.locked);

      // Resolve every bot's optional draw before allowing the first bot to
      // select a discard. Mandatory and clean-sweep draws already happened
      // together when this phase began.
      for (const bot of actionableBots) {
        if (bot.extraDrawPurchased || decisions.players.has(bot.id)) continue;
        const difficulty = room.players.find((player) => player.id === bot.id)?.botDifficulty;
        const advanced = difficulty === "advanced";
        const learned = difficulty === "learned";
        const recentLoss = room.recentBattleLosses.get(bot.id);
        const survivalMode = recentLoss?.battleRound === game.round && recentLoss.lossRatio >= 0.5;
        const advancedDraw = advanced
          ? ((yield { method: "chooseAdvancedDraw", args: [ports.advancedShuffleView(room, bot.id), null] }) as ReturnType<typeof chooseAdvancedDraw>)
          : null;
        const purchase = learned
          ? ((yield { method: "learned", args: [makeLearnedInput(room, bot.id, "buy"), null] }) as ReturnType<typeof shouldLearnedPurchaseExtraDraw>)
          : advanced
          ? advancedDraw!.purchase
          : ((yield { method: "shouldComputerPurchaseExtraDraw", args: [
              bot.hand,
              bot.hp,
              game.deck.length,
              null,
              survivalMode ? recentLoss.lossRatio : 0
            ] }) as ReturnType<typeof shouldComputerPurchaseExtraDraw>);
        ports.audit(room, now, "extra_draw_decision", "bot", bot.id, {
          purchase,
          difficulty,
          ...(advancedDraw ? { model: advancedDraw } : {}),
          handCounts: {
            rock: bot.hand.filter((card) => card.symbol === "rock").length,
            paper: bot.hand.filter((card) => card.symbol === "paper").length,
            scissors: bot.hand.filter((card) => card.symbol === "scissors").length
          },
          hp: bot.hp,
          deckCount: game.deck.length
        });
        if (purchase) {
          const card = purchaseExtraDraw(game, bot.id);
          ports.audit(room, now, "extra_card_drawn", "bot", bot.id, { card, hpCost: 1, difficulty });
        }
        decisions.players.add(bot.id);
      }

      for (const bot of actionableBots) {
        const difficulty = room.players.find((player) => player.id === bot.id)?.botDifficulty;
        const advanced = difficulty === "advanced";
        const learned = difficulty === "learned";
        const recentLoss = room.recentBattleLosses.get(bot.id);
        const survivalMode = recentLoss?.battleRound === game.round && recentLoss.lossRatio >= 0.5;
        const discardIds = learned
            ? ((yield { method: "learned", args: [makeLearnedInput(room, bot.id, "discard", bot.requiredDiscards), null] }) as ReturnType<typeof chooseLearnedDiscards>)
            : advanced
            ? ((yield { method: "chooseAdvancedTableDiscards", args: [ports.advancedShuffleView(room, bot.id), null] }) as ReturnType<typeof chooseAdvancedTableDiscards>)
            : ((yield { method: "chooseComputerDiscards", args: [bot.hand, bot.requiredDiscards, null, survivalMode] }) as ReturnType<typeof chooseComputerDiscards>);
        setDiscardSelection(game, bot.id, discardIds);
        ports.audit(room, now, "discard_selection_changed", "bot", bot.id, {
          cards: discardIds.map((cardId) => bot.hand.find((card) => card.id === cardId)!),
          difficulty,
          survivalMode
        });
        lockPlayer(game, bot.id);
        ports.audit(room, now, "player_locked", "bot", bot.id, {
          phase: "discard",
          cards: discardIds.map((cardId) => bot.hand.find((card) => card.id === cardId)!),
          difficulty
        });
      }
      if (duelistsLocked(game)) {
        ports.finalizeRoomDiscards(room, now);
        continue;
      }
      if (actionableBots.length === 0) return;
      return;
    }
    return;
  }
}
