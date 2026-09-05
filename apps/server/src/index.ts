import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { Server } from "socket.io";
import {
  cleanCardId,
  cleanCardIds,
  cleanBotDifficulty,
  cleanHeartDelta,
  cleanName,
  cleanRoomCode,
  cleanSlotIndex,
  type Ack,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SessionReceipt,
  type SocketData
} from "@rps/protocol";
import { RoomManager } from "./room-manager.js";
import { snapshotFor } from "./snapshots.js";
import { createJsonlStudyLogger } from "./study-log.js";

const app = express();
const httpServer = createServer(app);
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: { origin: true, credentials: true }
});
const rooms = new RoomManager();
const configuredStudyLog = process.env.RPS_STUDY_LOG?.trim();
const studyLogDisabled = configuredStudyLog !== undefined
  && ["0", "false", "off"].includes(configuredStudyLog.toLowerCase());
const studyLogPath = studyLogDisabled
  ? null
  : configuredStudyLog
    ? resolve(configuredStudyLog)
    : resolve(process.cwd(), "../../game-logs/games.jsonl");
if (studyLogPath) rooms.setStudyLogHandler(createJsonlStudyLogger(studyLogPath));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.rooms.size, now: Date.now() });
});

const clientDist = resolve(process.cwd(), "../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((request, response, next) => {
    if (request.method === "GET" && request.accepts("html")) {
      response.sendFile(resolve(clientDist, "index.html"));
      return;
    }
    next();
  });
}

rooms.setChangeHandler((room) => {
  const now = Date.now();
  for (const player of room.players) {
    if (player.socketId) {
      io.to(player.socketId).emit("state:snapshot", snapshotFor(room, player, now));
    }
  }
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected server error.";
}

io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  const bind = (receipt: SessionReceipt): void => {
    socket.data.roomCode = receipt.roomCode;
    socket.data.playerId = receipt.playerId;
  };

  const acknowledge = <T>(callback: (result: Ack<T>) => void, operation: () => T): void => {
    try {
      callback({ ok: true, data: operation() });
    } catch (error) {
      callback({ ok: false, error: errorMessage(error) });
    }
  };

  const context = (): { roomCode: string; playerId: string } => {
    if (!socket.data.roomCode || !socket.data.playerId) throw new Error("Join a room first.");
    return { roomCode: socket.data.roomCode, playerId: socket.data.playerId };
  };

  const action = (operation: (roomCode: string, playerId: string) => void): void => {
    try {
      const { roomCode, playerId } = context();
      operation(roomCode, playerId);
    } catch (error) {
      socket.emit("state:error", errorMessage(error));
    }
  };

  socket.on("room:create", (payload, callback) => {
    acknowledge(callback, () => {
      const receipt = rooms.createRoom(cleanName(payload.name), socket.id, Date.now());
      bind(receipt);
      const { room, player } = rooms.roomForPlayer(receipt.roomCode, receipt.playerId);
      socket.emit("state:snapshot", snapshotFor(room, player, Date.now()));
      return receipt;
    });
  });

  socket.on("room:join", (payload, callback) => {
    acknowledge(callback, () => {
      const receipt = rooms.joinRoom(cleanRoomCode(payload.roomCode), cleanName(payload.name), socket.id, Date.now());
      bind(receipt);
      return receipt;
    });
  });

  socket.on("room:resume", (payload, callback) => {
    acknowledge(callback, () => {
      const receipt = rooms.resumeRoom(
        {
          roomCode: cleanRoomCode(payload.roomCode),
          playerId: cleanCardId(payload.playerId) as string,
          token: cleanCardId(payload.token) as string
        },
        socket.id,
        Date.now()
      );
      bind(receipt);
      return receipt;
    });
  });

  socket.on("match:place", (payload) => action((roomCode, playerId) => {
    rooms.placeCard(roomCode, playerId, cleanSlotIndex(payload.slotIndex), cleanCardId(payload.cardId) as string, Date.now());
  }));

  socket.on("room:add-bot", (payload) => action((roomCode, playerId) => {
    rooms.addBot(roomCode, playerId, Date.now(), cleanBotDifficulty(payload?.difficulty));
  }));

  socket.on("room:remove-bot", (payload) => action((roomCode, playerId) => {
    rooms.removeBot(roomCode, playerId, cleanCardId(payload.playerId) as string, Date.now());
  }));

  socket.on("room:start", () => action((roomCode, playerId) => {
    rooms.startRoom(roomCode, playerId, Date.now());
  }));

  socket.on("match:target", (payload) => action((roomCode, playerId) => {
    rooms.selectTarget(roomCode, playerId, cleanCardId(payload.playerId) as string, Date.now());
  }));

  socket.on("match:hearts", (payload) => action((roomCode, playerId) => {
    rooms.adjustHearts(roomCode, playerId, cleanSlotIndex(payload.slotIndex), cleanHeartDelta(payload.delta), Date.now());
  }));

  socket.on("match:discard", (payload) => action((roomCode, playerId) => {
    rooms.selectDiscards(roomCode, playerId, cleanCardIds(payload.cardIds), Date.now());
  }));

  socket.on("match:buy-draw", () => action((roomCode, playerId) => {
    rooms.purchaseDraw(roomCode, playerId, Date.now());
  }));

  socket.on("match:lock", () => action((roomCode, playerId) => {
    rooms.lock(roomCode, playerId, Date.now());
  }));

  socket.on("room:rematch", () => action((roomCode, playerId) => {
    rooms.requestRematch(roomCode, playerId, Date.now());
  }));

  socket.on("room:leave", () => action((roomCode, playerId) => {
    rooms.leaveRoom(roomCode, playerId, Date.now());
    socket.data.roomCode = null;
    socket.data.playerId = null;
  }));

  socket.on("disconnect", () => rooms.disconnectSocket(socket.id, Date.now()));
});

const ticker = setInterval(() => rooms.tick(Date.now()), 100);
const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, "0.0.0.0", () => {
  process.stdout.write(`RPS server listening on http://localhost:${port}\n`);
  if (studyLogPath) process.stdout.write(`Study log: ${studyLogPath}\n`);
});

const shutdown = (): void => {
  clearInterval(ticker);
  io.close();
  httpServer.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
