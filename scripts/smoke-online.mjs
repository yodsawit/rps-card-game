import { io } from "socket.io-client";

function client(name) {
  const socket = io("http://localhost:3001", { transports: ["websocket"] });
  let latest = null;
  const listeners = new Set();
  socket.on("state:snapshot", (snapshot) => {
    latest = snapshot;
    for (const listener of listeners) listener(snapshot);
  });
  socket.on("state:error", (message) => {
    throw new Error(`${name}: ${message}`);
  });
  return {
    name,
    socket,
    connect: () => new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    }),
    waitFor(predicate, timeoutMs = 8_000) {
      if (latest && predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`${name}: timed out waiting for state.`));
        }, timeoutMs);
        const listener = (snapshot) => {
          if (!predicate(snapshot)) return;
          clearTimeout(timeout);
          listeners.delete(listener);
          resolve(snapshot);
        };
        listeners.add(listener);
      });
    }
  };
}

function createRoom(player) {
  return new Promise((resolve, reject) => {
    player.socket.emit("room:create", { name: player.name, versusComputer: false }, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(result.error));
    });
  });
}

function joinRoom(player, roomCode) {
  return new Promise((resolve, reject) => {
    player.socket.emit("room:join", { name: player.name, roomCode }, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(result.error));
    });
  });
}

const one = client("One");
const two = client("Two");
await Promise.all([one.connect(), two.connect()]);
const firstReceipt = await createRoom(one);
await joinRoom(two, firstReceipt.roomCode);

const [onePrep, twoPrep] = await Promise.all([
  one.waitFor((snapshot) => snapshot.kind === "match" && snapshot.phase === "preparation"),
  two.waitFor((snapshot) => snapshot.kind === "match" && snapshot.phase === "preparation")
]);
for (const view of [onePrep, twoPrep]) {
  const opponent = view.players.find((player) => player.id !== view.selfPlayerId);
  if (!opponent || opponent.slots.some((slot) => slot.symbol !== null)) {
    throw new Error("Online preparation leaked an opponent card symbol.");
  }
}

for (let lane = 0; lane < 3; lane += 1) {
  for (const [player, view] of [[one, onePrep], [two, twoPrep]]) {
    player.socket.emit("match:place", { slotIndex: lane, cardId: view.self.hand[lane].id });
    if (lane < 2) player.socket.emit("match:hearts", { slotIndex: lane, delta: lane === 0 ? 4 : 3 });
  }
  await Promise.all([one, two].map((player) => player.waitFor(
    (snapshot) => snapshot.kind === "match"
      && snapshot.phase === "preparation"
      && snapshot.activeLane === lane
      && snapshot.players.find((candidate) => candidate.id === snapshot.selfPlayerId).slots[lane].occupied
  )));
  one.socket.emit("match:lock");
  two.socket.emit("match:lock");
  if (lane < 2) {
    const staged = await Promise.all([one, two].map((player) => player.waitFor(
      (snapshot) => snapshot.kind === "match"
        && snapshot.phase === "preparation"
        && snapshot.activeLane === lane + 1
    )));
    for (const view of staged) {
      const opponent = view.players.find((player) => player.id !== view.selfPlayerId);
      if (opponent.slots[lane].symbol === null || opponent.slots[lane + 1].symbol !== null) {
        throw new Error("Online pair reveal exposed the wrong card position.");
      }
    }
  }
}
const [oneBattle, twoBattle] = await Promise.all([
  one.waitFor((snapshot) => snapshot.kind === "match" && (snapshot.phase === "battle" || snapshot.phase === "finished")),
  two.waitFor((snapshot) => snapshot.kind === "match" && (snapshot.phase === "battle" || snapshot.phase === "finished"))
]);
if (!oneBattle.battle || !twoBattle.battle) throw new Error("Online battle did not resolve.");
if (JSON.stringify(oneBattle.battle) !== JSON.stringify(twoBattle.battle)) {
  throw new Error("Online clients received different battle results.");
}

one.socket.emit("room:leave");
two.socket.emit("room:leave");
one.socket.disconnect();
two.socket.disconnect();
process.stdout.write(`ONLINE_SMOKE_OK room=${firstReceipt.roomCode}\n`);
