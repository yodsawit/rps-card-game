import { randomBytes, randomUUID } from "node:crypto";
import {
  adjustSlotHearts,
  advanceBattle,
  advancePreparationPair,
  assertMatchInvariants,
  autoCompleteDiscards,
  autoCompletePreparationPair,
  chooseAdvancedPair,
  chooseAdvancedDiscards,
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
  type BotDifficulty,
  type CardSymbol,
  type DrawChangeMemory,
  type MatchState,
  type RandomSource
} from "@rps/game-core";
import type { SessionReceipt } from "@rps/protocol";
import type { GameStudyEventHandler, GameStudyEventType } from "./study-log.js";
import type { Room, RoomPlayer } from "./types.js";

type RoomChanged = (room: Room) => void;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly random: RandomSource;
  private onChanged: RoomChanged = () => undefined;
  private onStudyEvent: GameStudyEventHandler = () => undefined;

  constructor(random: RandomSource = Math.random) {
    this.random = random;
  }

  setChangeHandler(handler: RoomChanged): void {
    this.onChanged = handler;
  }

  setStudyLogHandler(handler: GameStudyEventHandler): void {
    this.onStudyEvent = handler;
  }

  createRoom(name: string, socketId: string, now: number): SessionReceipt {
    const host = this.createHuman(name, socketId);
    const room: Room = {
      code: this.roomCode(),
      hostPlayerId: host.id,
      players: [host],
      game: null,
      knownHands: new Map(),
      recentBattleLosses: new Map(),
      lastObservedBattleRound: null,
      loggedOutcomeGameId: null,
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
    const prefix = difficulty === "advanced" ? "GTO" : "ARC";
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
    setCardPlacement(room.game!, playerId, slotIndex, cardId);
    this.changed(room, now);
  }

  adjustHearts(roomCode: string, playerId: string, slotIndex: 0 | 1 | 2, delta: number, now: number): void {
    const room = this.activeRoom(roomCode);
    adjustSlotHearts(room.game!, playerId, slotIndex, delta);
    this.changed(room, now);
  }

  selectDiscards(roomCode: string, playerId: string, cardIds: string[], now: number): void {
    const room = this.activeRoom(roomCode);
    setDiscardSelection(room.game!, playerId, cardIds);
    this.changed(room, now);
  }

  purchaseDraw(roomCode: string, playerId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    purchaseExtraDraw(room.game!, playerId);
    this.changed(room, now);
  }

  lock(roomCode: string, playerId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    lockPlayer(room.game!, playerId);
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
          for (const player of activeExpired) player.disconnectedAt = null;
          this.playComputers(room, now);
        }
      }
      if (this.rooms.has(room.code)) this.changed(room, now);
    }

    const game = room.game;
    if (!game || game.phase === "finished" || game.deadlineAt === null || now < game.deadlineAt) return;
    if (game.phase === "targeting") {
      this.selectRoomOpponent(room, game.attackerId, clockwiseOpponentId(game), now, "timeout");
    } else if (game.phase === "preparation") {
      autoCompletePreparationPair(game);
      this.advancePreparation(room, now);
    } else if (game.phase === "battle") {
      advanceBattle(game, now);
    } else if (game.phase === "discard") {
      autoCompleteDiscards(game);
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

  private selectRoomOpponent(
    room: Room,
    attackerId: string,
    targetId: string,
    now: number,
    source: "human" | "timeout" | "automatic" | "basic_bot" | "advanced_bot"
  ): void {
    selectOpponent(room.game!, attackerId, targetId, now);
    this.study(room, now, "target_selected", { attackerId, targetId, source });
  }

  private playComputers(room: Room, now: number): void {
    const game = room.game;
    if (!game) return;
    for (let guard = 0; guard < 30 && game.phase !== "finished"; guard += 1) {
      if (game.phase === "targeting") {
        const attacker = game.players.find((player) => player.id === game.attackerId)!;
        const living = game.players.filter((player) => !player.eliminated);
        if (living.length === 2) {
          const target = living.find((player) => player.id !== attacker.id)!;
          this.selectRoomOpponent(room, attacker.id, target.id, now, "automatic");
          continue;
        }
        if (!attacker.isBot) return;
        const advanced = room.players.find((player) => player.id === attacker.id)?.botDifficulty === "advanced";
        const targetId = advanced
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
        this.selectRoomOpponent(room, attacker.id, targetId, now, advanced ? "advanced_bot" : "basic_bot");
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
          const advanced = room.players.find((player) => player.id === bot.id)?.botDifficulty === "advanced";
          const opponentPositions = publicPositions(opponent.slots);
          const choice = advanced
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
          if (game.preparationLane < 2 && choice.hearts > 0) {
            adjustSlotHearts(game, bot.id, game.preparationLane, choice.hearts);
          }
          lockPlayer(game, bot.id);
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
        let acted = false;
        for (const bot of duelists.filter((player) => player.isBot && !player.locked)) {
          const advanced = room.players.find((player) => player.id === bot.id)?.botDifficulty === "advanced";
          const recentLoss = room.recentBattleLosses.get(bot.id);
          const survivalMode = recentLoss?.battleRound === game.round && recentLoss.lossRatio >= 0.5;
          if (!advanced && shouldComputerPurchaseExtraDraw(
            bot.hand,
            bot.hp,
            game.deck.length,
            this.random,
            survivalMode ? recentLoss.lossRatio : 0
          )) {
            purchaseExtraDraw(game, bot.id);
          }
          setDiscardSelection(
            game,
            bot.id,
            advanced
              ? chooseAdvancedDiscards(bot.hand, bot.requiredDiscards, this.random)
              : chooseComputerDiscards(bot.hand, bot.requiredDiscards, this.random, survivalMode)
          );
          lockPlayer(game, bot.id);
          acted = true;
        }
        if (duelistsLocked(game)) {
          this.finalizeRoomDiscards(room, now);
          continue;
        }
        if (!acted) return;
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
    room.game = createMatch(
      randomUUID(),
      room.players.map((player) => ({ id: player.id, name: player.name, isBot: player.isBot })),
      now,
      this.random
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
        copiesPerSymbol: room.game.config.copiesPerSymbol
      }
    });
  }

  private advancePreparation(room: Room, now: number): void {
    const game = room.game!;
    const completedLane = game.preparationLane;
    const duelistIds = [game.attackerId, game.defenderId!] as const;
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
    const outcome = finalizeDiscards(game, now, this.random);
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
    this.onStudyEvent({
      schemaVersion: 1,
      recordedAt: new Date(now).toISOString(),
      timestamp: now,
      roomCode: room.code,
      gameId: game.id,
      round,
      type,
      data
    });
  }

  private logOutcomeIfFinished(room: Room, now: number): void {
    const game = room.game;
    if (!game || game.phase !== "finished" || !game.outcome || room.loggedOutcomeGameId === game.id) return;
    room.loggedOutcomeGameId = game.id;
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
