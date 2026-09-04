import { randomBytes, randomUUID } from "node:crypto";
import {
  adjustSlotHearts,
  advancePreparationPair,
  allPlayersLocked,
  assertMatchInvariants,
  autoCompleteDiscards,
  chooseComputerDiscards,
  chooseComputerPair,
  createMatch,
  finalizeDiscards,
  forfeitMatch,
  lockPlayer,
  publicPositions,
  purchaseExtraDraw,
  setCardPlacement,
  setDiscardSelection,
  startDiscardPhase,
  shouldComputerPurchaseExtraDraw,
  type MatchState,
  type RandomSource
} from "@rps/game-core";
import type { SessionReceipt } from "@rps/protocol";
import type { Room, RoomPlayer } from "./types.js";

type RoomChanged = (room: Room) => void;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly random: RandomSource;
  private onChanged: RoomChanged = () => undefined;

  constructor(random: RandomSource = Math.random) {
    this.random = random;
  }

  setChangeHandler(handler: RoomChanged): void {
    this.onChanged = handler;
  }

  createRoom(name: string, socketId: string, versusComputer: boolean, now: number): SessionReceipt {
    const room: Room = {
      code: this.roomCode(),
      players: [this.createHuman(name, socketId)],
      game: null,
      createdAt: now,
      updatedAt: now
    };
    if (versusComputer) {
      room.players.push({
        id: randomUUID(),
        name: "ARC-3",
        token: "computer",
        isBot: true,
        socketId: null,
        disconnectedAt: null
      });
      this.startGame(room, now);
    }
    this.rooms.set(room.code, room);
    this.changed(room, now);
    return this.receipt(room.players[0]!, room.code);
  }

  joinRoom(code: string, name: string, socketId: string, now: number): SessionReceipt {
    const room = this.requireRoom(code);
    if (room.players.length >= 2) throw new Error("That room is already full.");
    if (room.game) throw new Error("That match has already started.");
    const player = this.createHuman(name, socketId);
    room.players.push(player);
    this.startGame(room, now);
    this.changed(room, now);
    return this.receipt(player, room.code);
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
    player.disconnectedAt = now - (room.game?.config.reconnectMs ?? 30_000);
    this.tickRoom(room, now);
  }

  placeCard(roomCode: string, playerId: string, slotIndex: 0 | 1 | 2, cardId: string | null, now: number): void {
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
    this.changed(room, now);
  }

  requestRematch(roomCode: string, playerId: string, now: number): void {
    const room = this.activeRoom(roomCode);
    if (room.game!.phase !== "finished") throw new Error("The current match is not finished.");
    const player = room.game!.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("Player is not part of this match.");
    player.rematchRequested = true;
    const bot = room.game!.players.find((candidate) => candidate.isBot);
    if (bot) bot.rematchRequested = true;
    if (room.game!.players.every((candidate) => candidate.rematchRequested)) {
      this.startGame(room, now);
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
    const expired = room.players.filter(
      (player) =>
        !player.isBot &&
        player.socketId === null &&
        player.disconnectedAt !== null &&
        now - player.disconnectedAt >= (room.game?.config.reconnectMs ?? 30_000)
    );
    if (expired.length > 0) {
      if (room.game && room.game.phase !== "finished") {
        forfeitMatch(room.game, expired.map((player) => player.id));
        this.changed(room, now);
      } else if (!room.game || room.game.phase === "finished") {
        this.rooms.delete(room.code);
      }
      return;
    }

    const game = room.game;
    if (!game || game.phase === "finished" || game.deadlineAt === null || now < game.deadlineAt) return;
    if (game.phase === "preparation") {
      advancePreparationPair(game, now);
      this.playComputer(room);
    } else if (game.phase === "battle") {
      startDiscardPhase(game, now);
      this.playComputer(room);
      this.advanceIfLocked(room, now);
    } else if (game.phase === "discard") {
      autoCompleteDiscards(game);
      finalizeDiscards(game, now, this.random);
      this.playComputer(room);
    }
    assertMatchInvariants(game);
    this.changed(room, now);
  }

  private advanceIfLocked(room: Room, now: number): void {
    const game = room.game!;
    if (!allPlayersLocked(game)) return;
    if (game.phase === "preparation") {
      advancePreparationPair(game, now);
      this.playComputer(room);
    } else if (game.phase === "discard") {
      finalizeDiscards(game, now, this.random);
      this.playComputer(room);
    }
    assertMatchInvariants(game);
  }

  private playComputer(room: Room): void {
    const game = room.game;
    if (!game || game.phase === "finished") return;
    const botIndex = game.players.findIndex((player) => player.isBot);
    if (botIndex < 0) return;
    const bot = game.players[botIndex as 0 | 1];
    if (bot.locked) return;
    const opponent = game.players[botIndex === 0 ? 1 : 0];

    if (game.phase === "preparation") {
      const choice = chooseComputerPair(
        {
          playerId: bot.id,
          hand: bot.hand,
          hp: bot.hp,
          activeLane: game.preparationLane,
          ownSlots: bot.slots,
          opponentPositions: publicPositions(opponent.slots)
        },
        this.random
      );
      setCardPlacement(game, bot.id, game.preparationLane, choice.cardId);
      if (game.preparationLane < 2 && choice.hearts > 0) {
        adjustSlotHearts(game, bot.id, game.preparationLane, choice.hearts);
      }
      lockPlayer(game, bot.id);
    } else if (game.phase === "discard") {
      if (shouldComputerPurchaseExtraDraw(bot.hand, bot.hp, game.deck.length, this.random)) {
        purchaseExtraDraw(game, bot.id);
      }
      setDiscardSelection(
        game,
        bot.id,
        chooseComputerDiscards(bot.hand, bot.requiredDiscards, this.random)
      );
      lockPlayer(game, bot.id);
    }
  }

  private startGame(room: Room, now: number): void {
    if (room.players.length !== 2) throw new Error("A game requires exactly two players.");
    room.game = createMatch(
      randomUUID(),
      room.players.map((player) => ({ id: player.id, name: player.name, isBot: player.isBot })) as [
        { id: string; name: string; isBot: boolean },
        { id: string; name: string; isBot: boolean }
      ],
      now,
      this.random
    );
    this.playComputer(room);
  }

  private createHuman(name: string, socketId: string): RoomPlayer {
    return {
      id: randomUUID(),
      name,
      token: randomBytes(24).toString("base64url"),
      isBot: false,
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
    if (!room) throw new Error("Room was not found.");
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

  private changed(room: Room, now: number): void {
    room.updatedAt = now;
    this.onChanged(room);
  }
}
