import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { Server } from "socket.io";
import {
  cleanActionTimeLimit,
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
import { createJsonlServerLogger } from "./server-log.js";
import { snapshotFor } from "./snapshots.js";
import { createJsonlStudyLogger } from "./study-log.js";
import { BotPool } from "./bot-pool.js";
import { RateLimit } from "./rate-limit.js";

const app = express();
const httpServer = createServer(app);
app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  next();
});
const connections = new RateLimit(60, 60_000);
const creations = new RateLimit(8, 60_000);
const actions = new RateLimit(240, 10_000);
const allowedOrigins = new Set((process.env.RPS_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean));
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  maxHttpBufferSize: 16_384,
  cors: { origin: (origin, callback) => callback(null, !origin || process.env.NODE_ENV !== "production" || allowedOrigins.has(origin)) },
  allowRequest: (request, callback) => {
    const address = request.socket.remoteAddress ?? "unknown";
    let originAllowed = !request.headers.origin || process.env.NODE_ENV !== "production";
    try {
      if (request.headers.origin) originAllowed ||= new URL(request.headers.origin).host === request.headers.host
        || allowedOrigins.has(request.headers.origin);
    } catch { originAllowed = false; }
    callback(null, originAllowed && connections.allow(address) && io.engine.clientsCount < 200);
  }
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
const studyLogger = studyLogPath ? createJsonlStudyLogger(studyLogPath) : null;
if (studyLogger) rooms.setStudyLogHandler(studyLogger);
const configuredServerLog = process.env.RPS_SERVER_LOG?.trim();
const serverLogDisabled = configuredServerLog !== undefined
  && ["0", "false", "off"].includes(configuredServerLog.toLowerCase());
const serverLogPath = serverLogDisabled
  ? null
  : configuredServerLog
    ? resolve(configuredServerLog)
    : resolve(process.cwd(), "../../game-logs/server-actions.jsonl");
const serverLogger = serverLogPath ? createJsonlServerLogger(serverLogPath) : null;
if (serverLogger) rooms.setServerLogHandler(serverLogger);
const botPool = new BotPool(rooms);
rooms.setComputerScheduler((room) => botPool.schedule(room));

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
  socket.use((packet, next) => {
    const valid = actions.allow(socket.handshake.address)
      && (packet[0] !== "room:create" || creations.allow(socket.handshake.address));
    if (valid) return next();
    const callback = packet.at(-1);
    if (typeof callback === "function") callback({ ok: false, error: "Too many requests. Wait a moment." });
    else socket.emit("state:error", "Too many requests. Wait a moment.");
  });

  const bind = (receipt: SessionReceipt): void => {
    socket.data.roomCode = receipt.roomCode;
    socket.data.playerId = receipt.playerId;
  };

  const acknowledge = <T>(callback: (result: Ack<T>) => void, operation: () => T): void => {
    if (typeof callback !== "function") {
      socket.emit("state:error", "This request requires an acknowledgement callback.");
      return;
    }
    try {
      callback({ ok: true, data: operation() });
    } catch (error) {
      callback({ ok: false, error: errorMessage(error) });
    }
  };

  const context = (): { roomCode: string; playerId: string } => {
    if (!socket.data.roomCode || !socket.data.playerId) throw new Error("Join a room first.");
    const { player } = rooms.roomForPlayer(socket.data.roomCode, socket.data.playerId);
    if (player.socketId !== socket.id) throw new Error("This seat is active on another connection.");
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

  socket.on("room:set-action-time", (payload) => action((roomCode, playerId) => {
    rooms.setActionTime(roomCode, playerId, cleanActionTimeLimit(payload?.actionTimeMs), Date.now());
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
  const address = httpServer.address();
  process.stdout.write(`RPS server listening on http://localhost:${typeof address === "object" ? address?.port : port}\n`);
  if (studyLogPath) process.stdout.write(`Study log: ${studyLogPath}\n`);
  if (serverLogPath) process.stdout.write(`Private server log: ${serverLogPath}\n`);
});
httpServer.on("error", (error: NodeJS.ErrnoException) => {
  process.stderr.write(error.code === "EADDRINUSE"
    ? `Port ${port} is already in use. Stop the other server or choose a different PORT.\n`
    : `Server could not start: ${error.message}\n`);
  clearInterval(ticker);
  process.exitCode = 1;
});

const shutdown = async (): Promise<void> => {
  clearInterval(ticker);
  const disconnected = new Promise<void>((resolve) => io.close(() => resolve()));
  await botPool.close();
  await disconnected;
  await Promise.all([studyLogger?.close(), serverLogger?.close()]);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
