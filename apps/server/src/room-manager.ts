import { randomBytes, randomUUID } from "node:crypto";
import {
  adjustSlotHearts,
  advanceBattle,
  advancePreparationPair,
  assertMatchInvariants,
  autoCompleteDiscards,
  autoCompletePreparationPair,
  beginPreparation,
  chooseAdvancedDraw,
  chooseAdvancedPair,
  chooseAdvancedTableDiscards,
  chooseAdvancedTarget,
  chooseComputerDiscards,
  chooseComputerPair,
  chooseComputerTarget,
  clockwiseOpponentId,
  createMatch,
  duelistsLocked,
  finalizeDiscards,
  forfeitPlayers,
  lockPlayer,
  MAX_SEATS,
  MIN_SEATS,
  publicPositions,
  purchaseExtraDraw,
  selectOpponent,
  setCardPlacement,
  setDiscardSelection,
  shouldComputerPurchaseExtraDraw,
  type AdvancedPairChoice,
  type AdvancedShuffleView,
  type BattleSummary,
  type BotDifficulty,
  type CardSymbol,
  type DrawChangeMemory,
  type MatchState,
  type RandomSource
} from "@rps/game-core";
import type {
  ActionTimeLimit,
  MatchRoundLogView,
  SessionReceipt
} from "@rps/protocol";
import {
  chooseLearnedDiscards,
  chooseLearnedPair,
  shouldLearnedPurchaseExtraDraw
} from "./learned-ai.js";
import type {
  ServerActionEventHandler,
  ServerActionSource
} from "./server-log.js";
import type { GameStudyEventHandler, GameStudyEventType } from "./study-log.js";
import type { Room, RoomPlayer } from "./types.js";

type RoomChanged = (room: Room) => void;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BOT_TARGET_THINK_MS = 1_000;

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly random: RandomSource;
  private onChanged: RoomChanged = () => undefined;
  private onStudyEvent: GameStudyEventHandler = () => undefined;
  private onServerAction: ServerActionEventHandler = () => undefined;

  constructor(random: RandomSource = Math.random) {
    this.random = random;
  }

  setChangeHandler(handler: RoomChanged): void {
    this.onChanged = handler;
  }

  setStudyLogHandler(handler: GameStudyEventHandler): void {
    this.onStudyEvent = handler;
  }

  setServerLogHandler(handler: ServerActionEventHandler): void {
    this.onServerAction = handler;
  }

  createRoom(name: string, socketId: string, now: number): SessionReceipt {
    const host = this.createHuman(name, socketId);
    const room: Room = {
      code: this.roomCode(),
      hostPlayerId: host.id,
      actionTimeMs: 20_000,
      players: [host],
      game: null,
      knownHands: new Map(),
      recentBattleLosses: new Map(),
      lastObservedBattleRound: null,
      loggedOutcomeGameId: null,
      matchLog: [],
      createdAt: now,
      updatedAt: now
    };
    this.rooms.set(room.code, room);
    this.changed(room, now);
    return this.receipt(host, room.code);
  }

  joinRoom(code: string, name: string, socketId: string, now: number): SessionReceipt {
    const room = this.requireRoom(code);
    if (room.game) throw new Error("That match has already started.");
    if (room.players.length >= MAX_SEATS) throw new Error("That room already has six seats.");
    const player = this.createHuman(name, socketId);
    room.players.push(player);
    this.changed(room, now);
    return this.receipt(player, room.code);
  }

  addBot(roomCode: string, playerId: string, now: number, difficulty: BotDifficulty = "basic"): void {
    const room = this.lobbyRoom(roomCode);
    this.requireHost(room, playerId);
    if (room.players.length >= MAX_SEATS) throw new Error("All six seats are occupied.");
    const prefix = difficulty === "advanced" ? "GTO" : difficulty === "learned" ? "RL" : "ARC";
    const usedNames = new Set(room.players.filter((player) => player.isBot).map((player) => player.name));
    let botNumber = 1;
    while (usedNames.has(`${prefix}-${botNumber}`)) botNumber += 1;
    room.players.push({
      id: randomUUID(),
      name: `${prefix}-${botNumber}`,
      token: "computer",
      isBot: true,
      botDifficulty: difficulty,
      socketId: null,
      disconnectedAt: null
    });
    this.changed(room, now);
  }

  removeBot(roomCode: string, playerId: string, botId: string, now: number): void {
    const room = this.lobbyRoom(roomCode);
    this.requireHost(room, playerId);
    const index = room.players.findIndex((player) => player.id === botId && player.isBot);
    if (index < 0) throw new Error("That computer seat does not exist.");
    room.players.splice(index, 1);
    this.changed(room, now);
  }

  setActionTime(roomCode: string, playerId: string, actionTimeMs: ActionTimeLimit, now: number): void {
    const room = this.lobbyRoom(roomCode);
    this.requireHost(room, playerId);
    room.actionTimeMs = actionTimeMs;
    this.changed(room, now);
  }

  startRoom(roomCode: string, playerId: string, now: number): void {
    const room = this.lobbyRoom(roomCode);
    this.requireHost(room, playerId);
    if (room.players.length < MIN_SEATS) throw new Error("At least two seats are required.");
    if (room.players.some((player) => !player.isBot && player.socketId === null)) {
      throw new Error("Wait for every human seat to reconnect before starting.");
    }
    this.startGame(room, now);
    this.playComputers(room, now);
    this.changed(room, now);
  }

  resumeRoom(receipt: SessionReceipt, socketId: string, now: number): SessionReceipt {
    const room = this.requireRoom(receipt.roomCode);
    const player = room.players.find(
      (candidate) => candidate.id === receipt.playerId && candidate.token === receipt.token && !candidate.isBot
    );
    if (!player) throw new Error("Saved match could not be resumed.");
    player.socketId = socketId;
    player.disconnectedAt = null;
    this.changed(room, now);
    return this.receipt(player, room.code);
  }

  disconnectSocket(socketId: string, now: number): void {
    for (const room of this.rooms.values()) {
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      if (!player) continue;
      player.socketId = null;
      player.disconnectedAt = now;
      this.changed(room, now);
      return;
    }
  }

  leaveRoom(roomCode: string, playerId: string, now: number): void {
    const room = this.requireRoom(roomCode);
    const player = this.requirePlayer(room, playerId);
    player.socketId = null;
    player.disconnectedAt = null;
    if (!room.game) {
      room.players = room.players.filter((candidate) => candidate.id !== playerId);
      if (!room.players.some((candidate) => !candidate.isBot)) {
        this.rooms.delete(room.code);
        return;
      }
      if (room.hostPlayerId === playerId) {
        room.hostPlayerId = room.players.find((candidate) => !candidate.isBot)!.id;
      }
    } else if (room.game.phase !== "finished") {
      forfeitPlayers(room.game, [playerId], now, this.random);
      this.audit(room, now, "player_forfeited", "human", playerId, { reason: "leave" });
      this.playComputers(room, now);
    }
    this.changed(room, now);
  }

  selectTarget(roomCode: string, playerId: string, targetId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    this.selectRoomOpponent(room, playerId, targetId, now, "human");
    this.playComputers(room, now);
    this.changed(room, now);
  }

  placeCard(roomCode: string, playerId: string, slotIndex: 0 | 1 | 2, cardId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    const game = room.game!;
    const card = game.players.find((player) => player.id === playerId)?.hand.find((candidate) => candidate.id === cardId);
    setCardPlacement(game, playerId, slotIndex, cardId);
    this.audit(room, now, "card_placed", "human", playerId, { slotIndex, card });
    this.changed(room, now);
  }

  adjustHearts(roomCode: string, playerId: string, slotIndex: 0 | 1 | 2, delta: number, now: number): void {
    const room = this.activeRoom(roomCode);
    const game = room.game!;
    adjustSlotHearts(game, playerId, slotIndex, delta);
    const hearts = game.players.find((player) => player.id === playerId)!.slots[slotIndex].hearts;
    this.audit(room, now, "hearts_committed", "human", playerId, { slotIndex, delta, hearts });
    this.changed(room, now);
  }

  selectDiscards(roomCode: string, playerId: string, cardIds: string[], now: number): void {
    const room = this.activeRoom(roomCode);
    const game = room.game!;
    const player = game.players.find((candidate) => candidate.id === playerId)!;
    setDiscardSelection(game, playerId, cardIds);
    this.audit(room, now, "discard_selection_changed", "human", playerId, {
      cards: cardIds.map((cardId) => player.hand.find((card) => card.id === cardId)!)
    });
    this.changed(room, now);
  }

  purchaseDraw(roomCode: string, playerId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    const card = purchaseExtraDraw(room.game!, playerId);
    this.audit(room, now, "extra_card_drawn", "human", playerId, { card, hpCost: 1 });
    this.changed(room, now);
  }

  lock(roomCode: string, playerId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    const game = room.game!;
    const phase = game.phase;
    const lane = game.preparationLane;
    const player = game.players.find((candidate) => candidate.id === playerId)!;
    const cardBefore = phase === "preparation" ? player.slots[lane].cardId : null;
    lockPlayer(game, playerId);
    const cardAfter = phase === "preparation" ? player.slots[lane].cardId : null;
    this.audit(room, now, "player_locked", "human", playerId, {
      phase,
      ...(phase === "preparation" ? {
        lane,
        autoPlacedCard: cardBefore === null && cardAfter !== null
          ? player.hand.find((card) => card.id === cardAfter)
          : null,
        hearts: player.slots[lane].hearts
      } : { discardSelection: [...player.discardSelection] })
    });
    this.advanceIfLocked(room, now);
    this.playComputers(room, now);
    assertMatchInvariants(room.game!);
    this.changed(room, now);
  }

  requestRematch(roomCode: string, playerId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    if (room.game!.phase !== "finished") throw new Error("The current match is not finished.");
    const player = room.game!.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("Player is not part of this match.");
    player.rematchRequested = true;
    this.audit(room, now, "rematch_requested", "human", playerId, {});
    for (const bot of room.game!.players.filter((candidate) => candidate.isBot)) bot.rematchRequested = true;
    if (room.game!.players.every((candidate) => candidate.rematchRequested)) {
      this.startGame(room, now);
      this.playComputers(room, now);
    }
    this.changed(room, now);
  }

  tick(now: number): void {
    for (const room of [...this.rooms.values()]) this.tickRoom(room, now);
  }

  roomForPlayer(roomCode: string, playerId: string): { room: Room; player: RoomPlayer } {
    const room = this.requireRoom(roomCode);
    return { room, player: this.requirePlayer(room, playerId) };
  }

  private tickRoom(room: Room, now: number): void {
    const reconnectMs = room.game?.config.reconnectMs ?? 30_000;
    const expired = room.players.filter((player) =>
      !player.isBot
      && player.socketId === null
      && player.disconnectedAt !== null
      && now - player.disconnectedAt >= reconnectMs
    );
    if (expired.length > 0) {
      if (!room.game) {
        const expiredIds = new Set(expired.map((player) => player.id));
        room.players = room.players.filter((player) => !expiredIds.has(player.id));
        if (!room.players.some((player) => !player.isBot)) {
          this.rooms.delete(room.code);
          return;
        }
        if (!room.players.some((player) => player.id === room.hostPlayerId)) {
          room.hostPlayerId = room.players.find((player) => !player.isBot)!.id;
        }
      } else if (room.game.phase === "finished") {
        if (room.players.filter((player) => !player.isBot).every((player) =>
          player.socketId === null
          && player.disconnectedAt !== null
          && now - player.disconnectedAt >= reconnectMs
        )) {
          this.rooms.delete(room.code);
          return;
        }
      } else {
        const activeExpired = expired.filter((roomPlayer) =>
          !room.game!.players.find((gamePlayer) => gamePlayer.id === roomPlayer.id)?.eliminated
        );
        if (activeExpired.length > 0) {
          forfeitPlayers(room.game, activeExpired.map((player) => player.id), now, this.random);
          for (const player of activeExpired) {
            player.disconnectedAt = null;
            this.audit(room, now, "player_forfeited", "system", player.id, { reason: "reconnect_timeout" });
          }
          this.playComputers(room, now);
        }
      }
      if (this.rooms.has(room.code)) this.changed(room, now);
    }

    const game = room.game;
    if (!game || game.phase === "finished" || game.deadlineAt === null || now < game.deadlineAt) return;
    if (game.phase === "targeting") {
      if (game.defenderId !== null) {
        beginPreparation(game, now);
        this.audit(room, now, "preparation_started", "system", null, {
          attackerId: game.attackerId,
          defenderId: game.defenderId
        });
      }
      else this.selectRoomOpponent(room, game.attackerId, clockwiseOpponentId(game), now, "timeout");
    } else if (game.phase === "preparation") {
      const lane = game.preparationLane;
      const before = new Map(game.players.map((player) => [player.id, player.slots[lane].cardId]));
      autoCompletePreparationPair(game);
      this.audit(room, now, "preparation_timed_out", "timeout", null, {
        lane,
        placements: game.players
          .filter((player) => player.id === game.attackerId || player.id === game.defenderId)
          .map((player) => {
            const cardId = player.slots[lane].cardId;
            return {
              playerId: player.id,
              wasAutoPlaced: before.get(player.id) === null && cardId !== null,
              card: player.hand.find((card) => card.id === cardId) ?? null,
              hearts: player.slots[lane].hearts
            };
          })
      });
      this.advancePreparation(room, now);
    } else if (game.phase === "battle") {
      this.advanceBattleWithAudit(room, now);
    } else if (game.phase === "discard") {
      autoCompleteDiscards(game);
      this.audit(room, now, "discard_timed_out", "timeout", null, {
        selections: game.players
          .filter((player) => player.id === game.attackerId || player.id === game.defenderId)
          .map((player) => ({
            playerId: player.id,
            cards: player.discardSelection.map((cardId) => player.hand.find((card) => card.id === cardId)!)
          }))
      });
      this.finalizeRoomDiscards(room, now);
    }
    this.playComputers(room, now);
    assertMatchInvariants(game);
    this.changed(room, now);
  }

  private advanceIfLocked(room: Room, now: number): void {
    const game = room.game!;
    if (!duelistsLocked(game)) return;
    if (game.phase === "preparation") this.advancePreparation(room, now);
    else if (game.phase === "discard") this.finalizeRoomDiscards(room, now);
  }

  private advanceBattleWithAudit(room: Room, now: number): void {
    const game = room.game!;
    advanceBattle(game, now);
    this.audit(room, now, "cards_drawn", "system", null, {
      players: game.players
        .filter((player) => player.id === game.attackerId || player.id === game.defenderId)
        .map((player) => ({
          playerId: player.id,
          cards: player.drawnCardIds.map((cardId) => player.hand.find((card) => card.id === cardId)!),
          requiredDiscards: player.requiredDiscards,
          bonusDraw: player.noLossBonus
        }))
    });
  }

  private advancedShuffleView(room: Room, playerId: string): AdvancedShuffleView {
    const game = room.game!;
    const player = game.players.find((candidate) => candidate.id === playerId)!;
    return {
      playerId,
      hand: player.hand,
      hp: player.hp,
      requiredDiscards: player.requiredDiscards,
      deckCount: game.deck.length,
      copiesPerSymbol: game.config.copiesPerSymbol,
      opponents: game.players
        .filter((opponent) => opponent.id !== playerId && !opponent.eliminated)
        .map((opponent) => {
          const observation = room.knownHands.get(opponent.id);
          const drawChanges = [...(observation?.drawChanges ?? [])];
          const currentHand = observation?.playedHands.find((hand) => hand.round === game.round);
          if (
            currentHand
            && opponent.drawnCardIds.length > 0
            && !drawChanges.some((change) => change.round === game.round)
          ) {
            drawChanges.push({
              round: game.round,
              drawnCount: opponent.drawnCardIds.length,
              discardedCount: 0,
              handDelta: opponent.drawnCardIds.length,
              bonusDraw: opponent.noLossBonus,
              paidDraw: opponent.extraDrawPurchased
            });
          }
          return {
            id: opponent.id,
            eliminated: opponent.eliminated,
            hp: opponent.hp,
            handCount: opponent.hand.length,
            memory: {
              playedHands: observation?.playedHands ?? [],
              drawChanges: drawChanges.slice(-2)
            }
          };
        })
    };
  }

  private selectRoomOpponent(
    room: Room,
    attackerId: string,
    targetId: string,
    now: number,
    source: "human" | "timeout" | "automatic" | "basic_bot" | "advanced_bot" | "learned_bot"
  ): void {
    const game = room.game!;
    selectOpponent(game, attackerId, targetId, now);
    const attackerIsBot = room.players.find((player) => player.id === attackerId)?.isBot === true;
    const waitsBeforePunch = attackerIsBot || source === "automatic";
    if (waitsBeforePunch && game.deadlineAt !== null) game.deadlineAt += BOT_TARGET_THINK_MS;
    this.ensureRoundLog(room);
    this.study(room, now, "target_selected", { attackerId, targetId, source });
  }

  private ensureRoundLog(room: Room): MatchRoundLogView {
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

  private recordBattleLog(
    room: Room,
    battle: BattleSummary,
    handsBeforeDrawDiscard: ReadonlyMap<string, CardSymbol[]>
  ): void {
    const entry = this.ensureRoundLog(room);
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

  private playComputers(room: Room, now: number): void {
    const game = room.game;
    if (!game) return;
    for (let guard = 0; guard < 30 && game.phase !== "finished"; guard += 1) {
      if (game.phase === "targeting") {
        if (game.defenderId !== null) return;
        const attacker = game.players.find((player) => player.id === game.attackerId)!;
        const living = game.players.filter((player) => !player.eliminated);
        if (living.length === 2) {
          const target = living.find((player) => player.id !== attacker.id)!;
          this.selectRoomOpponent(room, attacker.id, target.id, now, "automatic");
          continue;
        }
        if (!attacker.isBot) return;
        const difficulty = room.players.find((player) => player.id === attacker.id)?.botDifficulty;
        const advanced = difficulty === "advanced";
        const learned = difficulty === "learned";
        const targetId = advanced || learned
          ? chooseAdvancedTarget({
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
            }, this.random)
          : chooseComputerTarget(
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
              this.random
            );
        this.selectRoomOpponent(
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
            ? chooseLearnedPair(room, bot.id, this.random)
            : advanced
            ? chooseAdvancedPair({
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
              }, this.random)
            : chooseComputerPair({
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
              }, this.random);
          if (advanced) {
            const advancedChoice = choice as AdvancedPairChoice;
            const ownHandCounts: Record<CardSymbol, number> = { rock: 0, paper: 0, scissors: 0 };
            for (const card of bot.hand) ownHandCounts[card.symbol] += 1;
            this.study(room, now, "advanced_pair_decision", {
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
          this.audit(room, now, "card_placed", "bot", bot.id, {
            slotIndex: game.preparationLane,
            card: bot.hand.find((card) => card.id === choice.cardId),
            difficulty
          });
          if (game.preparationLane < 2 && choice.hearts > 0) {
            adjustSlotHearts(game, bot.id, game.preparationLane, choice.hearts);
            this.audit(room, now, "hearts_committed", "bot", bot.id, {
              slotIndex: game.preparationLane,
              delta: choice.hearts,
              hearts: bot.slots[game.preparationLane].hearts,
              difficulty
            });
          }
          lockPlayer(game, bot.id);
          this.audit(room, now, "player_locked", "bot", bot.id, {
            phase: "preparation",
            lane: game.preparationLane,
            card: bot.hand.find((card) => card.id === bot.slots[game.preparationLane].cardId),
            hearts: bot.slots[game.preparationLane].hearts,
            difficulty
          });
          acted = true;
        }
        if (duelistsLocked(game)) {
          this.advancePreparation(room, now);
          continue;
        }
        if (!acted) return;
        return;
      }

      if (game.phase === "discard") {
        const duelists = game.players.filter((player) =>
          player.id === game.attackerId || player.id === game.defenderId
        );
        const actionableBots = duelists.filter((player) => player.isBot && !player.locked);

        // Resolve every bot's optional draw before allowing the first bot to
        // select a discard. Mandatory and clean-sweep draws already happened
        // together when this phase began.
        for (const bot of actionableBots) {
          const difficulty = room.players.find((player) => player.id === bot.id)?.botDifficulty;
          const advanced = difficulty === "advanced";
          const learned = difficulty === "learned";
          const recentLoss = room.recentBattleLosses.get(bot.id);
          const survivalMode = recentLoss?.battleRound === game.round && recentLoss.lossRatio >= 0.5;
          const advancedDraw = advanced
            ? chooseAdvancedDraw(this.advancedShuffleView(room, bot.id), this.random)
            : null;
          const purchase = learned
            ? shouldLearnedPurchaseExtraDraw(room, bot.id, this.random)
            : advanced
            ? advancedDraw!.purchase
            : shouldComputerPurchaseExtraDraw(
                bot.hand,
                bot.hp,
                game.deck.length,
                this.random,
                survivalMode ? recentLoss.lossRatio : 0
              );
          this.audit(room, now, "extra_draw_decision", "bot", bot.id, {
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
            this.audit(room, now, "extra_card_drawn", "bot", bot.id, { card, hpCost: 1, difficulty });
          }
        }

        for (const bot of actionableBots) {
          const difficulty = room.players.find((player) => player.id === bot.id)?.botDifficulty;
          const advanced = difficulty === "advanced";
          const learned = difficulty === "learned";
          const recentLoss = room.recentBattleLosses.get(bot.id);
          const survivalMode = recentLoss?.battleRound === game.round && recentLoss.lossRatio >= 0.5;
          const discardIds = learned
              ? chooseLearnedDiscards(room, bot.id, bot.requiredDiscards, this.random)
              : advanced
              ? chooseAdvancedTableDiscards(this.advancedShuffleView(room, bot.id), this.random)
              : chooseComputerDiscards(bot.hand, bot.requiredDiscards, this.random, survivalMode);
          setDiscardSelection(game, bot.id, discardIds);
          this.audit(room, now, "discard_selection_changed", "bot", bot.id, {
            cards: discardIds.map((cardId) => bot.hand.find((card) => card.id === cardId)!),
            difficulty,
            survivalMode
          });
          lockPlayer(game, bot.id);
          this.audit(room, now, "player_locked", "bot", bot.id, {
            phase: "discard",
            cards: discardIds.map((cardId) => bot.hand.find((card) => card.id === cardId)!),
            difficulty
          });
        }
        if (duelistsLocked(game)) {
          this.finalizeRoomDiscards(room, now);
          continue;
        }
        if (actionableBots.length === 0) return;
        return;
      }
      return;
    }
  }

  private startGame(room: Room, now: number): void {
    room.knownHands.clear();
    room.recentBattleLosses.clear();
    room.lastObservedBattleRound = null;
    room.loggedOutcomeGameId = null;
    room.matchLog = [];
    room.game = createMatch(
      randomUUID(),
      room.players.map((player) => ({ id: player.id, name: player.name, isBot: player.isBot })),
      now,
      this.random,
      {
        targetSelectionMs: room.actionTimeMs,
        preparationMs: room.actionTimeMs,
        discardMs: room.actionTimeMs
      }
    );
    this.study(room, now, "match_started", {
      players: room.players.map((player, seatIndex) => ({
        playerId: player.id,
        name: player.name,
        seatIndex,
        isBot: player.isBot,
        botDifficulty: player.botDifficulty
      })),
      config: {
        startingHp: room.game.config.startingHp,
        startingHandSize: room.game.config.startingHandSize,
        maximumHandSize: room.game.config.maximumHandSize,
        copiesPerSymbol: room.game.config.copiesPerSymbol,
        actionTimeMs: room.actionTimeMs,
        duelIntroMs: room.game.config.duelIntroMs,
        battleRevealMs: room.game.config.battleRevealMs
      }
    });
    this.audit(room, now, "initial_cards_drawn", "system", null, {
      players: room.game.players.map((player) => ({
        playerId: player.id,
        cards: player.hand.map((card) => ({ ...card }))
      }))
    });
  }

  private advancePreparation(room: Room, now: number): void {
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
      this.recordBattleLog(room, battle, handsBeforeDrawDiscard);
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

  private finalizeRoomDiscards(room: Room, now: number): void {
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

  private createHuman(name: string, socketId: string): RoomPlayer {
    return {
      id: randomUUID(),
      name,
      token: randomBytes(24).toString("base64url"),
      isBot: false,
      botDifficulty: null,
      socketId,
      disconnectedAt: null
    };
  }

  private receipt(player: RoomPlayer, roomCode: string): SessionReceipt {
    return { roomCode, playerId: player.id, token: player.token };
  }

  private roomCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = Array.from({ length: 5 }, () =>
        CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)]
      ).join("");
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("Could not allocate a room code.");
  }

  private requireRoom(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new Error("Room was not found on this server. Confirm every device uses the same host and port.");
    return room;
  }

  private lobbyRoom(code: string): Room {
    const room = this.requireRoom(code);
    if (room.game) throw new Error("The match has already started.");
    return room;
  }

  private activeRoom(code: string): Room {
    const room = this.requireRoom(code);
    if (!room.game) throw new Error("The match has not started.");
    return room;
  }

  private requirePlayer(room: Room, playerId: string): RoomPlayer {
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("Player is not part of this room.");
    return player;
  }

  private requireHost(room: Room, playerId: string): void {
    if (room.hostPlayerId !== playerId) throw new Error("Only the room host can change seats or start.");
  }

  private study(
    room: Room,
    now: number,
    type: GameStudyEventType,
    data: Record<string, unknown>,
    round = room.game?.round ?? 0
  ): void {
    const game = room.game;
    if (!game) return;
    const event = {
      schemaVersion: 1,
      recordedAt: new Date(now).toISOString(),
      timestamp: now,
      roomCode: room.code,
      gameId: game.id,
      round,
      type,
      data
    } as const;
    this.onStudyEvent(event);
    this.audit(room, now, type, "system", null, data, round);
  }

  private audit(
    room: Room,
    now: number,
    type: string,
    source: ServerActionSource,
    actorId: string | null,
    data: Record<string, unknown>,
    round = room.game?.round ?? 0
  ): void {
    const game = room.game;
    if (!game) return;
    const state = JSON.parse(JSON.stringify(game)) as Record<string, unknown>;
    state.players = game.players.map((player) => ({
      ...(JSON.parse(JSON.stringify(player)) as Record<string, unknown>),
      botDifficulty: room.players.find((candidate) => candidate.id === player.id)?.botDifficulty ?? null
    }));
    this.onServerAction({
      schemaVersion: 1,
      visibility: "server_only",
      recordedAt: new Date(now).toISOString(),
      timestamp: now,
      roomCode: room.code,
      gameId: game.id,
      round,
      type,
      source,
      actorId,
      data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
      state
    });
  }

  private logOutcomeIfFinished(room: Room, now: number): void {
    const game = room.game;
    if (!game || game.phase !== "finished" || !game.outcome || room.loggedOutcomeGameId === game.id) return;
    room.loggedOutcomeGameId = game.id;
    const finalRound = this.ensureRoundLog(room);
    for (const playerLog of finalRound.players) {
      const player = game.players.find((candidate) => candidate.id === playerLog.playerId)!;
      playerLog.hpAfter = player.hp;
      playerLog.handCountAfter = player.hand.length;
      playerLog.eliminatedAfter = player.eliminated;
    }
    this.study(room, now, "match_finished", {
      outcome: game.outcome,
      standings: game.players.map((player) => ({
        playerId: player.id,
        name: player.name,
        hp: player.hp,
        handCount: player.hand.length,
        eliminated: player.eliminated,
        isBot: player.isBot,
        botDifficulty: room.players.find((candidate) => candidate.id === player.id)?.botDifficulty ?? null
      }))
    });
  }

  private changed(room: Room, now: number): void {
    this.logOutcomeIfFinished(room, now);
    room.updatedAt = now;
    this.onChanged(room);
  }
}
