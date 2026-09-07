import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { io, type Socket } from "socket.io-client";
import type { MatchSnapshot, SessionReceipt } from "@rps/protocol";

let server: ChildProcess;
let url = "";
const sockets: Socket[] = [];
beforeAll(async () => {
  server = spawn(process.execPath, process.env.RPS_TEST_BUILT === "1"
    ? ["dist/index.js"] : ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, PORT: "0", NODE_ENV: "production", RPS_STUDY_LOG: "off", RPS_SERVER_LOG: "off" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  // test/../ is the server workspace, independent of the test runner's cwd.
  let output = "", errors = "";
  server.stderr!.on("data", (chunk) => { errors += chunk; });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { url = `http://127.0.0.1:${match[1]}`; resolve(); }
    });
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
  });
}, 10_000);
afterAll(async () => {
  sockets.forEach((socket) => socket.disconnect());
  if (server?.exitCode === null) {
    const exit = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    server.kill();
    await exit;
  }
});
async function connect(): Promise<Socket> {
  const socket = io(url, { transports: ["websocket"], reconnection: false, timeout: 2000 });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return socket;
}
function receipt(socket: Socket, event: string, payload: unknown): Promise<SessionReceipt> {
  return new Promise((resolve, reject) => socket.emit(event, payload, (result: { ok: boolean; data: SessionReceipt; error: string }) => {
    if (result.ok) resolve(result.data); else reject(new Error(result.error));
  }));
}

it("rejects missing acknowledgements without crashing or creating a room", async () => {
  const socket = await connect();
  const error = new Promise<string>((resolve) => socket.once("state:error", resolve));
  socket.emit("room:create", { name: "No ack" });
  expect(await error).toContain("acknowledgement");
  expect(((await (await fetch(`${url}/api/health`)).json()) as { rooms: number }).rooms).toBe(0);
});

it("rejects the previous socket after a seat is resumed", async () => {
  const old = await connect();
  const session = await receipt(old, "room:create", { name: "Host" });
  const fresh = await connect();
  await receipt(fresh, "room:resume", session);
  const error = new Promise<string>((resolve) => old.once("state:error", resolve));
  old.emit("room:add-bot", { difficulty: "basic" });
  expect(await error).toContain("another connection");
  fresh.emit("room:leave");
});

it("runs GTO in the development worker while health requests remain available", async () => {
  const socket = await connect();
  await receipt(socket, "room:create", { name: "Worker test" });
  socket.emit("room:add-bot", { difficulty: "advanced" });
  const placed = new Promise<MatchSnapshot>((resolve) => {
    socket.on("state:snapshot", (snapshot) => {
      if (snapshot.kind === "match" && snapshot.phase === "preparation" && snapshot.players.some((player: { isBot: boolean; locked: boolean }) => player.isBot && player.locked)) resolve(snapshot);
    });
  });
  socket.emit("room:start");
  expect((await fetch(`${url}/api/health`)).ok).toBe(true);
  expect((await placed).players.some((player) => player.isBot && player.slots[0].occupied)).toBe(true);
  socket.emit("room:leave");
}, 18_000);

it("rejects untrusted browser origins in production", async () => {
  const socket = io(url, { transports: ["websocket"], reconnection: false, timeout: 1000, extraHeaders: { Origin: "https://untrusted.invalid" } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect_error", () => resolve()); socket.once("connect", () => reject(new Error("Untrusted origin connected"))); });
});
