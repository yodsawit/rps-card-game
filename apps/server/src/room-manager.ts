import { RoundTransitions } from "./round-transitions.js";
import { RoomSessions } from "./room-sessions.js";
import { computerTurn } from "./bot-turn.js";
import { ensureRoundLog } from "./match-journal.js";
import { randomUUID } from "node:crypto";
import { computeBotDecision, type BotTurn } from "./bot-decisions.js";
import { adjustSlotHearts, advanceBattle, assertMatchInvariants, autoCompleteDiscards, autoCompletePreparationPair, beginPreparation, BOT_TARGET_THINK_MS, clockwiseOpponentId, createMatch, duelistsLocked, forfeitPlayers, lockPlayer, MAX_SEATS, MIN_SEATS, purchaseExtraDraw, selectOpponent, setCardPlacement, setDiscardSelection, type AdvancedShuffleView, type BotDifficulty, type RandomSource } from "@rps/game-core";
import type { ActionTimeLimit, SessionReceipt } from "@rps/protocol";
import type { ServerActionEventHandler, ServerActionSource } from "./server-log.js";
import type { GameStudyEventHandler, GameStudyEventType } from "./study-log.js";
import type { Room, RoomPlayer } from "./types.js";

type RoomChanged = (room: Room) => void;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly sessions = new RoomSessions(this.rooms, (room, now) => this.changed(room, now), (code) => this.requireRoom(code));
  private readonly random: RandomSource;
  private onChanged: RoomChanged = () => undefined;
  private onStudyEvent: GameStudyEventHandler = () => undefined;
  private onServerAction: ServerActionEventHandler = () => undefined;
  private auditEnabled = false;
  private computerScheduler: ((room: Room) => void) | null = null;
  private readonly faultedRooms = new Set<string>();

  setComputerScheduler(handler: (room: Room) => void): void {
    this.computerScheduler = handler;
  }

  runComputerTurn(room: Room, now: number): void {
    const turn = this.computerTurn(room, now);
    let step = turn.next();
    while (!step.done) step = turn.next(computeBotDecision(step.value, this.random));
    assertMatchInvariants(room.game!);
  }

  publishComputerTurn(room: Room, now: number): void {
    assertMatchInvariants(room.game!);
    this.changed(room, now);
  }

  failRoom(room: Room, error: unknown): void {
    if (this.faultedRooms.has(room.code)) return;
    this.faultedRooms.add(room.code);
    process.stderr.write(`Room ${room.code} stopped: ${error instanceof Error ? error.message : "unexpected error"}\n`);
    // Stop only this match; other rooms and reconnects remain available.
    if (room.game) {
      room.game.phase = "finished";
      room.game.deadlineAt = null;
      room.game.outcome = { kind: "draw", winnerId: null, reason: "error" };
    }
    this.changed(room, Date.now());
  }

  private requireUnusedSocket(socketId: string): void { this.sessions.requireUnusedSocket(socketId); }

  constructor(random: RandomSource = Math.random) {
    this.random = random;
    this.transitions = new RoundTransitions(random, this.study.bind(this), this.audit.bind(this));
  }

  setChangeHandler(handler: RoomChanged): void {
    this.onChanged = handler;
  }

  setStudyLogHandler(handler: GameStudyEventHandler): void {
    this.onStudyEvent = handler;
  }

  setServerLogHandler(handler: ServerActionEventHandler): void {
    this.onServerAction = handler;
    this.auditEnabled = true;
  }

  createRoom(name: string, socketId: string, now: number): SessionReceipt {
    this.requireUnusedSocket(socketId);
    if (this.rooms.size >= 100) throw new Error("The server is full. Try again shortly.");
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
    this.requireUnusedSocket(socketId);
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
    return this.sessions.resumeRoom(receipt, socketId, now);
  }

  disconnectSocket(socketId: string, now: number): void {
    this.sessions.disconnectSocket(socketId, now);
  }

  leaveRoom(roomCode: string, playerId: string, now: number): void {
    const room = this.requireRoom(roomCode);
    const player = this.requirePlayer(room, playerId);
    player.socketId = null;
    player.disconnectedAt = null;
    player.token = "departed";
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
      this.forfeitRoomPlayers(room, [playerId], now);
      this.audit(room, now, "player_forfeited", "human", playerId, { reason: "leave" });
      this.playComputers(room, now);
    }
    if (!room.players.some((candidate) => !candidate.isBot && candidate.token !== "departed")) {
      this.rooms.delete(room.code);
      return;
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
    const participants = room.players.filter((candidate) => candidate.isBot || candidate.socketId !== null);
    if (participants.length >= MIN_SEATS && participants.every((candidate) =>
      room.game!.players.find((player) => player.id === candidate.id)!.rematchRequested
    )) {
      room.players = participants;
      if (!participants.some((player) => player.id === room.hostPlayerId)) {
        room.hostPlayerId = participants.find((player) => !player.isBot)!.id;
      }
      this.startGame(room, now);
      this.playComputers(room, now);
    }
    this.changed(room, now);
  }

  tick(now: number): void {
    for (const room of [...this.rooms.values()]) {
      try { this.tickRoom(room, now); }
      catch (error) { this.failRoom(room, error); }
    }
  }

  roomForPlayer(roomCode: string, playerId: string): { room: Room; player: RoomPlayer } {
    const room = this.requireRoom(roomCode);
    return { room, player: this.requirePlayer(room, playerId) };
  }

  private tickRoom(room: Room, now: number): void {
    const reconnectMs = room.game?.config.reconnectMs ?? 30_000;
    const humans = room.players.filter((player) => !player.isBot);
    if (humans.length > 0 && humans.every((player) => player.socketId === null
      && (player.token === "departed" || (player.disconnectedAt !== null && now - player.disconnectedAt >= reconnectMs)))) {
      this.rooms.delete(room.code);
      this.faultedRooms.delete(room.code);
      return;
    }
    if (this.faultedRooms.has(room.code)) return;
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
          this.forfeitRoomPlayers(room, activeExpired.map((player) => player.id), now);
          for (const player of activeExpired) {
            player.disconnectedAt = null;
            player.token = "departed";
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

  private forfeitRoomPlayers(room: Room, ids: string[], now: number): void {
    const game = room.game!;
    const entry = room.matchLog.find((round) => round.round === game.round);
    const interrupted = game.phase === "discard" && ids.some((id) =>
      (id === game.attackerId || id === game.defenderId) && !game.players.find((player) => player.id === id)?.eliminated
    );
    if (interrupted) {
      autoCompleteDiscards(game);
      for (const player of game.players.filter((player) => player.id === game.attackerId || player.id === game.defenderId)) {
        const log = entry?.players.find((record) => record.playerId === player.id);
        if (!log) continue;
        log.drawnCards = player.drawnCardIds.map((id) => player.hand.find((card) => card.id === id)!.symbol);
        log.discardedCards = player.discardSelection.map((id) => player.hand.find((card) => card.id === id)!.symbol);
        log.paidExtraDraw = player.extraDrawPurchased;
        log.bonusDraw = player.noLossBonus;
      }
      this.audit(room, now, "interrupted_discards_committed", "system", null, {
        selections: game.players.map((player) => ({ playerId: player.id, discarded: [...player.discardSelection] }))
      });
    }
    forfeitPlayers(game, ids, now, this.random);
    for (const log of entry?.players ?? []) {
      const player = game.players.find((candidate) => candidate.id === log.playerId)!;
      log.hpAfter = player.hp;
      log.handCountAfter = player.hand.length;
      log.eliminatedAfter = player.eliminated;
    }
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
    this.advanceIfLocked(room, now);
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

  private ensureRoundLog = ensureRoundLog;

  private playComputers(room: Room, now: number): void {
    if (this.computerScheduler) {
      queueMicrotask(() => this.computerScheduler?.(room));
    } else this.runComputerTurn(room, now);
  }

  computerTurn(room: Room, now: number): BotTurn {
    return computerTurn(room, now, {
      advancedShuffleView: this.advancedShuffleView.bind(this),
      selectRoomOpponent: this.selectRoomOpponent.bind(this),
      study: this.study.bind(this),
      audit: this.audit.bind(this),
      advancePreparation: this.advancePreparation.bind(this),
      finalizeRoomDiscards: this.finalizeRoomDiscards.bind(this)
    });
  }

  private startGame(room: Room, now: number): void {
    this.faultedRooms.delete(room.code);
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

  private readonly transitions: RoundTransitions;
  private advancePreparation(room: Room, now: number): void { this.transitions.advancePreparation(room, now); }
  private finalizeRoomDiscards(room: Room, now: number): void { this.transitions.finalizeRoomDiscards(room, now); }

  private createHuman(name: string, socketId: string): RoomPlayer {
    return this.sessions.createHuman(name, socketId);
  }

  private receipt(player: RoomPlayer, roomCode: string): SessionReceipt {
    return this.sessions.receipt(player, roomCode);
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
    if (!game || !this.auditEnabled) return;
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
    room.revision = (room.revision ?? 0) + 1;
    this.logOutcomeIfFinished(room, now);
    room.updatedAt = now;
    this.onChanged(room);
  }
}
