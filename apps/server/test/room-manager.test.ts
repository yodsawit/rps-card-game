import { describe, expect, it } from "vitest";
import { seededRandom } from "@rps/game-core";
import { RoomManager } from "../src/room-manager.js";
import { snapshotFor } from "../src/snapshots.js";
import type { GameStudyEvent } from "../src/study-log.js";

function finishDuelIntro(manager: RoomManager, roomCode: string): void {
  const game = manager.rooms.get(roomCode)!.game!;
  expect(game.phase).toBe("targeting");
  expect(game.defenderId).not.toBeNull();
  manager.tick(game.deadlineAt!);
}

describe("RoomManager", () => {
  it("creates a lobby where the host can manage up to six seats and start", () => {
    const manager = new RoomManager(seededRandom(44));
    const receipt = manager.createRoom("Host", "socket-1", 1_000);
    const initial = manager.roomForPlayer(receipt.roomCode, receipt.playerId);
    const lobby = snapshotFor(initial.room, initial.player, 1_001);

    expect(lobby.kind).toBe("lobby");
    if (lobby.kind !== "lobby") return;
    expect(lobby.hostPlayerId).toBe(receipt.playerId);
    expect(lobby.maximumSeats).toBe(6);
    expect(lobby.actionTimeMs).toBe(20_000);
    expect(lobby.players).toHaveLength(1);

    for (let index = 0; index < 5; index += 1) {
      manager.addBot(receipt.roomCode, receipt.playerId, 1_100 + index);
    }
    expect(initial.room.players.map((player) => player.name)).toEqual([
      "Host", "ARC-1", "ARC-2", "ARC-3", "ARC-4", "ARC-5"
    ]);
    expect(() => manager.addBot(receipt.roomCode, receipt.playerId, 2_000)).toThrow("six seats");

    const removed = initial.room.players[2]!;
    manager.removeBot(receipt.roomCode, receipt.playerId, removed.id, 2_100);
    manager.addBot(receipt.roomCode, receipt.playerId, 2_200);
    expect(new Set(initial.room.players.map((player) => player.name)).size).toBe(6);
    manager.startRoom(receipt.roomCode, receipt.playerId, 3_000);

    expect(initial.room.game?.players).toHaveLength(6);
    expect(initial.room.game?.config.copiesPerSymbol).toBe(10);
    expect(initial.room.game?.phase).toBe("targeting");
  });

  it("lets the host choose a shared action timer, including no limit", () => {
    const manager = new RoomManager(seededRandom(45));
    const host = manager.createRoom("Host", "socket-1", 1_000);
    const guest = manager.joinRoom(host.roomCode, "Guest", "socket-2", 1_010);
    const room = manager.rooms.get(host.roomCode)!;

    expect(() => manager.setActionTime(room.code, guest.playerId, 30_000, 1_020)).toThrow("Only the room host");
    manager.setActionTime(room.code, host.playerId, 30_000, 1_025);
    const timedLobby = snapshotFor(room, room.players[0]!, 1_026);
    expect(timedLobby.kind === "lobby" && timedLobby.actionTimeMs).toBe(30_000);
    manager.setActionTime(room.code, host.playerId, null, 1_030);
    const lobby = snapshotFor(room, room.players[0]!, 1_031);
    expect(lobby.kind === "lobby" && lobby.actionTimeMs).toBeNull();

    manager.startRoom(room.code, host.playerId, 1_100);
    expect(room.game!.deadlineAt).toBe(3_100);
    finishDuelIntro(manager, room.code);
    expect(room.game!.phase).toBe("preparation");
    expect(room.game!.deadlineAt).toBeNull();
    expect(room.game!.config.targetSelectionMs).toBeNull();
    expect(room.game!.config.preparationMs).toBeNull();
    expect(room.game!.config.discardMs).toBeNull();
  });

  it("waits in the lobby for human joins and restricts start controls to the host", () => {
    const manager = new RoomManager(seededRandom(8));
    const first = manager.createRoom("One", "socket-1", 1_000);
    const second = manager.joinRoom(first.roomCode, "Two", "socket-2", 1_100);
    const room = manager.rooms.get(first.roomCode)!;

    expect(room.game).toBeNull();
    expect(() => manager.addBot(room.code, second.playerId, 1_200)).toThrow("Only the room host");
    expect(() => manager.startRoom(room.code, second.playerId, 1_200)).toThrow("Only the room host");
    manager.startRoom(room.code, first.playerId, 1_300);
    finishDuelIntro(manager, room.code);
    expect(room.game?.phase).toBe("preparation");
    expect(room.game?.defenderId).toBe(second.playerId);
    expect(room.game?.players).toHaveLength(2);
  });

  it("adds a separately labeled advanced bot and lets its solver commit a hidden pair", () => {
    const manager = new RoomManager(seededRandom(61));
    const studyEvents: GameStudyEvent[] = [];
    manager.setStudyLogHandler((event) => studyEvents.push(event));
    const receipt = manager.createRoom("Host", "socket-1", 1_000);
    manager.addBot(receipt.roomCode, receipt.playerId, 1_010, "advanced");
    const room = manager.rooms.get(receipt.roomCode)!;
    const advanced = room.players.find((player) => player.isBot)!;

    expect(advanced.name).toBe("GTO-1");
    expect(advanced.botDifficulty).toBe("advanced");
    const lobby = snapshotFor(room, room.players[0]!, 1_020);
    expect(lobby.kind).toBe("lobby");
    if (lobby.kind !== "lobby") return;
    expect(lobby.players.find((player) => player.id === advanced.id)?.botDifficulty).toBe("advanced");

    manager.startRoom(room.code, receipt.playerId, 1_100);
    finishDuelIntro(manager, room.code);
    const gameBot = room.game!.players.find((player) => player.id === advanced.id)!;
    expect(gameBot.slots[0].cardId).not.toBeNull();
    expect(gameBot.locked).toBe(true);
    const view = snapshotFor(room, room.players[0]!, 1_201);
    expect(view.kind).toBe("match");
    if (view.kind !== "match") return;
    expect(view.players.find((player) => player.id === advanced.id)?.slots[0].symbol).toBeNull();
    expect(studyEvents.map((event) => event.type)).toEqual([
      "match_started",
      "target_selected",
      "advanced_pair_decision"
    ]);
    expect(studyEvents.find((event) => event.type === "target_selected")?.data).toMatchObject({
      attackerId: receipt.playerId,
      targetId: advanced.id,
      source: "automatic"
    });
    const decision = studyEvents.find((event) => event.type === "advanced_pair_decision")!;
    expect(decision.data).toMatchObject({
      playerId: advanced.id,
      opponentId: receipt.playerId,
      lane: 0,
      ownHandCounts: expect.objectContaining({ rock: expect.any(Number), paper: expect.any(Number), scissors: expect.any(Number) }),
      choice: expect.objectContaining({
        symbol: expect.stringMatching(/rock|paper|scissors/),
        hearts: expect.any(Number),
        equilibriumValue: expect.any(Number)
      }),
      model: expect.objectContaining({
        sampleCount: 512,
        sampledHands: expect.any(Array),
        nextCardProbabilities: expect.objectContaining({
          rock: expect.any(Number),
          paper: expect.any(Number),
          scissors: expect.any(Number)
        }),
        ownPlanCount: expect.any(Number),
        opponentSequenceCount: expect.any(Number),
        currentActions: expect.any(Array)
      })
    });
    expect(JSON.stringify(decision.data)).not.toMatch(/cardId|token|socketId/);
  });

  it("solves an advanced response with every seat occupied", () => {
    const manager = new RoomManager(seededRandom(63));
    const receipt = manager.createRoom("Host", "socket-1", 1_000);
    for (let index = 0; index < 5; index += 1) {
      manager.addBot(receipt.roomCode, receipt.playerId, 1_010 + index, "advanced");
    }
    const room = manager.rooms.get(receipt.roomCode)!;
    manager.startRoom(room.code, receipt.playerId, 1_100);
    const target = room.game!.players.find((player) => player.isBot)!;

    manager.selectTarget(room.code, receipt.playerId, target.id, 1_200);
    finishDuelIntro(manager, room.code);

    expect(room.game!.players).toHaveLength(6);
    expect(target.slots[0].cardId).not.toBeNull();
    expect(target.locked).toBe(true);
  });

  it("has the attacker select a target, then hides the current bot card", () => {
    const manager = new RoomManager(seededRandom(12));
    const receipt = manager.createRoom("Human", "socket-1", 1_000);
    manager.addBot(receipt.roomCode, receipt.playerId, 1_010);
    manager.addBot(receipt.roomCode, receipt.playerId, 1_020);
    manager.startRoom(receipt.roomCode, receipt.playerId, 1_100);
    const { room, player } = manager.roomForPlayer(receipt.roomCode, receipt.playerId);
    const bot = room.players.find((candidate) => candidate.isBot)!;

    manager.selectTarget(room.code, player.id, bot.id, 1_200);
    finishDuelIntro(manager, room.code);
    const view = snapshotFor(room, player, 1_201);
    expect(view.kind).toBe("match");
    if (view.kind !== "match") return;
    expect(view.phase).toBe("preparation");
    expect(view.attackerId).toBe(player.id);
    expect(view.defenderId).toBe(bot.id);
    const botView = view.players.find((candidate) => candidate.id === bot.id)!;
    expect(botView.slots[0]).toMatchObject({ occupied: true, symbol: null });
    expect(view.players.find((candidate) => candidate.id === room.players[2]!.id)?.slots.every((slot) => !slot.occupied)).toBe(true);
  });

  it("remembers only publicly revealed battle cards for later bot targeting", () => {
    const manager = new RoomManager(seededRandom(17));
    const receipt = manager.createRoom("Human", "socket-1", 1_000);
    manager.addBot(receipt.roomCode, receipt.playerId, 1_010);
    manager.joinRoom(receipt.roomCode, "Observer", "socket-2", 1_020);
    manager.startRoom(receipt.roomCode, receipt.playerId, 1_100);
    const room = manager.rooms.get(receipt.roomCode)!;
    const game = room.game!;
    const human = game.players.find((candidate) => candidate.id === receipt.playerId)!;
    const bot = game.players.find((candidate) => candidate.isBot)!;
    manager.selectTarget(room.code, human.id, bot.id, 1_200);
    finishDuelIntro(manager, room.code);
    human.hand = human.hand.map((card) => ({ ...card, symbol: "rock" as const }));
    room.knownHands.set(human.id, {
      symbols: ["rock", "rock", "rock"],
      observedRound: 0,
      tripleSymbol: "rock",
      consecutiveTripleUses: 1,
      playedHands: [{
        round: 0,
        handCount: 3,
        symbols: ["rock", "rock", "rock"],
        hearts: [3, 3, 4]
      }],
      drawChanges: []
    });

    for (let lane = 0; lane < 3; lane += 1) {
      manager.placeCard(room.code, human.id, lane as 0 | 1 | 2, human.hand[lane]!.id, 1_300 + lane * 10);
      if (lane < 2) manager.adjustHearts(room.code, human.id, lane as 0 | 1, lane === 0 ? 4 : 3, 1_301 + lane * 10);
      manager.lock(room.code, human.id, 1_302 + lane * 10);
    }

    expect(room.knownHands.get(human.id)).toEqual({
      symbols: game.battle!.lanes.map((lane) => lane.sides.find((side) => side.playerId === human.id)!.card!.symbol),
      observedRound: 1,
      tripleSymbol: "rock",
      consecutiveTripleUses: 2,
      playedHands: [
        {
          round: 0,
          handCount: 3,
          symbols: ["rock", "rock", "rock"],
          hearts: [3, 3, 4]
        },
        {
          round: 1,
          handCount: 3,
          symbols: ["rock", "rock", "rock"],
          hearts: game.battle!.lanes.map((lane) =>
            lane.sides.find((side) => side.playerId === human.id)!.hearts
          )
        }
      ],
      drawChanges: []
    });
    expect(room.knownHands.get(bot.id)?.symbols).toHaveLength(3);
    expect(room.lastObservedBattleRound).toBe(1);
    const humanLoss = Math.max(10 - game.battle!.resultingHp[0], 0);
    expect(room.recentBattleLosses.get(human.id)).toEqual({
      hpLost: humanLoss,
      lossRatio: humanLoss / 10,
      battleRound: 1
    });
  });

  it("adds public draw-count changes to the shared two-entry bot memory", () => {
    const manager = new RoomManager(seededRandom(62));
    const studyEvents: GameStudyEvent[] = [];
    manager.setStudyLogHandler((event) => studyEvents.push(event));
    const receipt = manager.createRoom("Human", "socket-1", 1_000);
    manager.addBot(receipt.roomCode, receipt.playerId, 1_010);
    manager.joinRoom(receipt.roomCode, "Observer", "socket-2", 1_020);
    manager.startRoom(receipt.roomCode, receipt.playerId, 1_100);
    const room = manager.rooms.get(receipt.roomCode)!;
    const game = room.game!;
    const human = game.players.find((player) => player.id === receipt.playerId)!;
    const bot = game.players.find((player) => player.isBot)!;
    human.hand = human.hand.map((card) => ({ ...card, symbol: "rock" as const }));
    bot.hand = bot.hand.map((card) => ({ ...card, symbol: "rock" as const }));
    manager.selectTarget(room.code, human.id, bot.id, 1_200);
    finishDuelIntro(manager, room.code);

    for (let lane = 0; lane < 3; lane += 1) {
      manager.placeCard(room.code, human.id, lane as 0 | 1 | 2, human.hand[lane]!.id, 1_300 + lane * 10);
      manager.lock(room.code, human.id, 1_301 + lane * 10);
    }
    expect(game.phase).toBe("battle");
    manager.tick(game.deadlineAt!);
    expect(game.phase).toBe("discard");
    manager.selectDiscards(room.code, human.id, human.hand.slice(0, human.requiredDiscards).map((card) => card.id), 12_100);
    manager.lock(room.code, human.id, 12_101);

    expect(room.knownHands.get(human.id)?.drawChanges).toEqual([{
      round: 1,
      drawnCount: 2,
      discardedCount: 1,
      handDelta: 1,
      bonusDraw: true,
      paidDraw: false
    }]);
    expect(room.knownHands.get(human.id)?.playedHands).toHaveLength(1);
    expect(studyEvents.filter((event) => event.type === "pair_revealed")).toHaveLength(3);
    expect(studyEvents.filter((event) => event.type === "battle_resolved")).toHaveLength(1);
    const shuffle = studyEvents.find((event) => event.type === "shuffle_resolved")!;
    expect(shuffle.round).toBe(1);
    expect(shuffle.data).toMatchObject({
      players: expect.arrayContaining([
        expect.objectContaining({
          playerId: human.id,
          drawnCount: 2,
          discardedCount: 1,
          handDelta: 1,
          bonusDraw: true,
          paidDraw: false
        })
      ])
    });
    expect(JSON.stringify(studyEvents)).not.toMatch(/token|socketId|cardId/);
  });

  it("reveals each completed pair to duelists and spectators from left to right", () => {
    const manager = new RoomManager(seededRandom(19));
    const first = manager.createRoom("One", "socket-1", 1_000);
    const second = manager.joinRoom(first.roomCode, "Two", "socket-2", 1_010);
    const third = manager.joinRoom(first.roomCode, "Three", "socket-3", 1_020);
    manager.startRoom(first.roomCode, first.playerId, 1_100);
    const room = manager.rooms.get(first.roomCode)!;
    manager.selectTarget(room.code, first.playerId, second.playerId, 1_200);
    finishDuelIntro(manager, room.code);
    const game = room.game!;
    const left = game.players.find((candidate) => candidate.id === first.playerId)!;
    const right = game.players.find((candidate) => candidate.id === second.playerId)!;

    manager.placeCard(room.code, left.id, 0, left.hand[0]!.id, 1_300);
    manager.adjustHearts(room.code, left.id, 0, 4, 1_301);
    manager.placeCard(room.code, right.id, 0, right.hand[0]!.id, 1_302);
    manager.adjustHearts(room.code, right.id, 0, 3, 1_303);
    const spectator = manager.roomForPlayer(room.code, third.playerId).player;
    const hidden = snapshotFor(room, spectator, 1_304);
    expect(hidden.kind).toBe("match");
    if (hidden.kind !== "match") return;
    expect(hidden.players.find((candidate) => candidate.id === left.id)!.slots[0]!.symbol).toBeNull();

    manager.lock(room.code, left.id, 1_400);
    manager.lock(room.code, right.id, 1_401);
    const revealed = snapshotFor(room, spectator, 1_402);
    expect(revealed.kind).toBe("match");
    if (revealed.kind !== "match") return;
    expect(revealed.activeLane).toBe(1);
    expect(revealed.players.find((candidate) => candidate.id === left.id)!.slots[0]!.symbol).not.toBeNull();
    expect(revealed.players.find((candidate) => candidate.id === right.id)!.slots[0]!.symbol).not.toBeNull();
    expect(revealed.players.find((candidate) => candidate.id === left.id)!.slots[1]!.symbol).toBeNull();
  });

  it("preserves private fresh-draw identifiers only in the owner's view", () => {
    const manager = new RoomManager(seededRandom(20));
    const receipt = manager.createRoom("Human", "socket-1", 1_000);
    manager.addBot(receipt.roomCode, receipt.playerId, 1_010);
    manager.startRoom(receipt.roomCode, receipt.playerId, 1_100);
    const { room, player } = manager.roomForPlayer(receipt.roomCode, receipt.playerId);
    const human = room.game!.players.find((candidate) => candidate.id === player.id)!;
    human.drawnCardIds = [human.hand[0]!.id];

    const view = snapshotFor(room, player, 1_101);
    expect(view.kind).toBe("match");
    if (view.kind !== "match") return;
    expect(view.self.drawnCardIds).toEqual([human.hand[0]!.id]);
    expect(view.players.every((candidate) => !("drawnCardIds" in candidate))).toBe(true);
  });

  it("forfeits one disconnected seat after thirty seconds and continues a group match", () => {
    const manager = new RoomManager(seededRandom(3));
    const first = manager.createRoom("One", "socket-1", 1_000);
    const second = manager.joinRoom(first.roomCode, "Two", "socket-2", 1_010);
    const third = manager.joinRoom(first.roomCode, "Three", "socket-3", 1_020);
    manager.startRoom(first.roomCode, first.playerId, 1_100);
    manager.disconnectSocket("socket-1", 2_000);
    manager.tick(32_000);

    const game = manager.rooms.get(first.roomCode)?.game;
    expect(game?.outcome).toBeNull();
    expect(game?.players.find((player) => player.id === first.playerId)?.eliminated).toBe(true);
    expect(game?.attackerId).toBe(second.playerId);
    expect(game?.defenderId).toBe(third.playerId);
    finishDuelIntro(manager, first.roomCode);
    expect(game?.phase).toBe("preparation");
  });

  it("logs a final outcome once without private connection credentials", () => {
    const manager = new RoomManager(seededRandom(64));
    const studyEvents: GameStudyEvent[] = [];
    manager.setStudyLogHandler((event) => studyEvents.push(event));
    const first = manager.createRoom("One", "socket-1", 1_000);
    const second = manager.joinRoom(first.roomCode, "Two", "socket-2", 1_010);
    manager.startRoom(first.roomCode, first.playerId, 1_100);

    manager.leaveRoom(first.roomCode, second.playerId, 1_200);
    manager.tick(1_300);

    const finished = studyEvents.filter((event) => event.type === "match_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.data).toMatchObject({
      outcome: { kind: "winner", winnerId: first.playerId, reason: "forfeit" }
    });
    expect(JSON.stringify(finished)).not.toMatch(/token|socketId|cardId/);
  });

  it("uses the next clockwise living opponent when target selection expires", () => {
    const manager = new RoomManager(seededRandom(31));
    const first = manager.createRoom("One", "socket-1", 1_000);
    const second = manager.joinRoom(first.roomCode, "Two", "socket-2", 1_010);
    manager.joinRoom(first.roomCode, "Three", "socket-3", 1_020);
    manager.startRoom(first.roomCode, first.playerId, 1_100);
    const game = manager.rooms.get(first.roomCode)!.game!;

    manager.tick(game.deadlineAt!);
    expect(game.phase).toBe("targeting");
    expect(game.defenderId).toBe(second.playerId);
    manager.tick(game.deadlineAt!);
    expect(game.phase).toBe("preparation");
    expect(game.defenderId).toBe(second.playerId);
  });

  it("commits each duelist's leftmost card but no early HP when a pair timer expires", () => {
    const manager = new RoomManager(seededRandom(52));
    const first = manager.createRoom("One", "socket-1", 1_000);
    const second = manager.joinRoom(first.roomCode, "Two", "socket-2", 1_010);
    manager.startRoom(first.roomCode, first.playerId, 1_100);
    const game = manager.rooms.get(first.roomCode)!.game!;
    const left = game.players.find((candidate) => candidate.id === first.playerId)!;
    const right = game.players.find((candidate) => candidate.id === second.playerId)!;
    const leftmost = left.hand[0]!.id;
    const rightmost = right.hand[0]!.id;

    finishDuelIntro(manager, first.roomCode);
    manager.lock(first.roomCode, first.playerId, 1_300);
    manager.tick(game.deadlineAt!);

    expect(game.phase).toBe("preparation");
    expect(game.preparationLane).toBe(1);
    expect(left.slots[0]).toEqual({ cardId: leftmost, hearts: 0 });
    expect(right.slots[0]).toEqual({ cardId: rightmost, hearts: 0 });
    expect(left.locked).toBe(false);
    expect(right.locked).toBe(false);
  });
});
