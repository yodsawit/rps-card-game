import { randomBytes, randomUUID } from "node:crypto";
import type { SessionReceipt } from "@rps/protocol";
import type { Room, RoomPlayer } from "./types.js";

export class RoomSessions {
  constructor(
    private readonly rooms: Map<string, Room>,
    private readonly changed: (room: Room, now: number) => void,
    private readonly requireRoom: (code: string) => Room
  ) {}

  requireUnusedSocket(socketId: string): void {
    if ([...this.rooms.values()].some((room) => room.players.some((player) => player.socketId === socketId))) {
      throw new Error("Leave your current room before joining another.");
    }
  }

  resumeRoom(receipt: SessionReceipt, socketId: string, now: number): SessionReceipt {
    const room = this.requireRoom(receipt.roomCode);
    const player = room.players.find(
      (candidate) => candidate.id === receipt.playerId && candidate.token === receipt.token && !candidate.isBot
    );
    if (!player) throw new Error("Saved match could not be resumed.");
    if (player.token === "departed") throw new Error("This seat has left the match.");
    if (player.socketId !== socketId) this.requireUnusedSocket(socketId);
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
    }
  }

  createHuman(name: string, socketId: string): RoomPlayer {
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

  receipt(player: RoomPlayer, roomCode: string): SessionReceipt {
    return { roomCode, playerId: player.id, token: player.token };
  }

}
