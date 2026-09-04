import { io } from "socket.io-client";

const socket = io("http://localhost:3001", { transports: ["websocket"] });
let latest = null;
const listeners = new Set();

socket.on("state:snapshot", (snapshot) => {
  latest = snapshot;
  for (const listener of listeners) listener(snapshot);
});
socket.on("state:error", (message) => {
  throw new Error(message);
});

function waitFor(predicate, timeoutMs = 10_000) {
  if (latest && predicate(latest)) return Promise.resolve(latest);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error("Timed out waiting for server state."));
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

await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", reject);
});

const receipt = await new Promise((resolve, reject) => {
  socket.emit("room:create", { name: "Smoke", versusComputer: true }, (result) => {
    if (result.ok) resolve(result.data);
    else reject(new Error(result.error));
  });
});

const preparation = await waitFor(
  (snapshot) => snapshot.kind === "match" && snapshot.phase === "preparation"
);
const bot = preparation.players.find((player) => player.isBot);
if (!bot || bot.slots.some((slot) => slot.symbol !== null)) {
  throw new Error("Opponent hidden cards leaked during preparation.");
}

let resolved;
for (let lane = 0; lane < 3; lane += 1) {
  socket.emit("match:place", { slotIndex: lane, cardId: preparation.self.hand[lane].id });
  await waitFor(
    (snapshot) => snapshot.kind === "match"
      && snapshot.phase === "preparation"
      && snapshot.activeLane === lane
      && snapshot.players.find((player) => player.id === snapshot.selfPlayerId).slots[lane].occupied
  );
  if (lane < 2) {
    const hearts = lane === 0 ? 4 : 3;
    socket.emit("match:hearts", { slotIndex: lane, delta: hearts });
    await waitFor(
      (snapshot) => snapshot.kind === "match"
        && snapshot.phase === "preparation"
        && snapshot.activeLane === lane
        && snapshot.players.find((player) => player.id === snapshot.selfPlayerId).slots[lane].hearts === hearts
    );
  }
  socket.emit("match:lock");
  if (lane < 2) {
    const next = await waitFor(
      (snapshot) => snapshot.kind === "match"
        && snapshot.phase === "preparation"
        && snapshot.activeLane === lane + 1
    );
    const nextOpponent = next.players.find((player) => player.id !== next.selfPlayerId);
    if (nextOpponent.slots[lane].symbol === null || nextOpponent.slots[lane + 1].symbol !== null) {
      throw new Error("Sequential pair reveal leaked the wrong opponent position.");
    }
  } else {
    resolved = await waitFor(
      (snapshot) => snapshot.kind === "match" && (snapshot.phase === "battle" || snapshot.phase === "finished")
    );
  }
}
if (!resolved.battle || resolved.battle.lanes.some((lane) => lane.sides.some((side) => side.symbol === null))) {
  throw new Error("Battle did not reveal all occupied card symbols.");
}

if (resolved.phase !== "finished") {
  const discard = await waitFor(
    (snapshot) => snapshot.kind === "match" && snapshot.phase === "discard",
    12_000
  );
  let discardView = discard;
  if (discard.players.find((player) => player.id === discard.selfPlayerId).hp > 1 && discard.deckCount > 0) {
    const beforeHand = discard.self.hand.length;
    const beforeRequired = discard.self.requiredDiscards;
    const beforeHp = discard.players.find((player) => player.id === discard.selfPlayerId).hp;
    socket.emit("match:buy-draw");
    discardView = await waitFor(
      (snapshot) => snapshot.kind === "match"
        && snapshot.phase === "discard"
        && snapshot.self.extraDrawPurchased
    );
    const afterHp = discardView.players.find((player) => player.id === discardView.selfPlayerId).hp;
    if (
      discardView.self.hand.length !== beforeHand + 1
      || discardView.self.requiredDiscards !== beforeRequired + 1
      || afterHp !== beforeHp - 1
    ) {
      throw new Error("Paid draw did not apply its HP, draw, and discard costs.");
    }
  }
  const selected = discardView.self.hand.slice(-discardView.self.requiredDiscards).map((card) => card.id);
  socket.emit("match:discard", { cardIds: selected });
  await waitFor(
    (snapshot) =>
      snapshot.kind === "match" &&
      snapshot.phase === "discard" &&
      snapshot.self.discardSelection.length === snapshot.self.requiredDiscards
  );
  socket.emit("match:lock");
  await waitFor(
    (snapshot) => snapshot.kind === "match" && (snapshot.phase === "preparation" || snapshot.phase === "finished")
  );
}

socket.emit("room:leave");
socket.disconnect();
process.stdout.write(`SMOKE_OK room=${receipt.roomCode}\n`);
