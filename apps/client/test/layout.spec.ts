import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

async function loadClient(page: Page): Promise<void> {
  const styles = await build({ entryPoints: ["apps/client/src/style.css"], bundle: true, write: false });
  const css = styles.outputFiles[0]!.text;
  await page.setContent('<style>' + css + '</style><div id="app"></div><div id="toast"></div><div id="audio-controls"></div>');
  const bundle = await build({ entryPoints: ["apps/client/test/browser-fixture.ts"], bundle: true,
    write: false, platform: "browser", format: "iife" });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
}

const players = ["LongPlayerName1234", "ARC-1", "GTO-1"].map((name, index) => ({
  id: `p${index}`, name, seatIndex: index, hp: 10, connected: true, handCount: 3, locked: false,
  slots: [{ occupied: true, hearts: 0, symbol: "rock" }, { occupied: false, hearts: 0, symbol: null }, { occupied: false, hearts: 0, symbol: null }]
}));

test("disposing the application releases its clock and socket listeners", async ({ page }) => {
  await loadClient(page);
  const state = await page.evaluate(() => {
    const client = (globalThis as any).reviewClient;
    const before = client.resources();
    client.dispose();
    client.dispose();
    return { before, after: client.resources() };
  });
  expect(state.before.intervals).toBe(1);
  expect(state.before.listeners).toBeGreaterThan(0);
  expect(state.after).toEqual({ intervals: 0, listeners: 0 });
});

test("background music follows the page and result volume levels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loadClient(page);
  await page.evaluate(() => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => null, setItem: () => undefined, removeItem: () => undefined
  } }));
  await page.evaluate(() => (globalThis as any).reviewClient.connect());
  expect(await page.evaluate(() => (globalThis as any).audioPageEvents)).toEqual([1]);
  await page.evaluate((snapshot) => {
    const client = (globalThis as any).reviewClient;
    client.snapshot = snapshot;
    client.render();
  }, { kind: "lobby", roomCode: "MUSIC", selfPlayerId: "p0", hostPlayerId: "p0", maximumSeats: 6,
    actionTimeMs: 20_000, players: [{ id: "p0", seatIndex: 0, name: "Arb", isBot: false, botDifficulty: null, connected: true }] });
  expect(await page.evaluate(() => (globalThis as any).audioPageEvents)).toEqual([1, 1]);
  await page.evaluate((snapshot) => {
    const client = (globalThis as any).reviewClient;
    client.snapshot = snapshot;
    client.render();
  }, battleSnapshot());
  expect(await page.evaluate(() => (globalThis as any).audioPageEvents)).toEqual([1, 1, 0.5]);
  await page.evaluate((snapshot) => {
    const client = (globalThis as any).reviewClient;
    client.snapshot = snapshot;
    client.render();
  }, { ...battleSnapshot(), phase: "finished", battle: null,
    outcome: { kind: "winner", winnerId: "p0", reason: "hp" } });
  expect(await page.evaluate(() => (globalThis as any).audioPageEvents)).toEqual([1, 1, 0.5, 0.5]);
  await page.waitForTimeout(1_500);
  expect(await page.evaluate(() => (globalThis as any).audioPageEvents)).toEqual([1, 1, 0.5, 0.5, 1]);
});

test("all tutorial slides keep one stable dialog size", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadClient(page);
  const sizes = await page.evaluate(() => {
    const client = (globalThis as any).reviewClient;
    client.openTutorial();
    return [0, 1, 2, 3, 4].map((index) => {
      (document.querySelector(`[data-tutorial-slide='${index}']`) as HTMLElement).click();
      const rect = document.querySelector(".tutorial-dialog")!.getBoundingClientRect();
      return [Math.round(rect.width), Math.round(rect.height)];
    });
  });
  expect(new Set(sizes.map((size) => size.join("x"))).size).toBe(1);
});

test("clash effects use the actual outer-lane center", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1000 });
  await loadClient(page);
  const view = battleSnapshot();
  await page.evaluate((snapshot) => {
    const client = (globalThis as any).reviewClient;
    client.snapshot = snapshot;
    client.render();
  }, view);
  await page.waitForTimeout(2800);
  const geometry = await page.evaluate(() => {
    const events = (globalThis as any).effectEvents
      .filter((entry: unknown[]) => entry[0] === "lane-clash-fx")
      .map((entry: unknown[]) => entry[1]);
    const centers = [0, 1, 2].map((lane) => {
      const rect = document.querySelector(`.battle-lane[data-slot="${lane}"] .versus-line`)!.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    return { events, centers };
  });
  expect(geometry.events).toHaveLength(3);
  geometry.events.forEach((event: { x: number; y: number }, lane: number) => {
    expect(event.x).toBeCloseTo(geometry.centers[lane]!.x, 3);
    expect(event.y).toBeCloseTo(geometry.centers[lane]!.y, 3);
  });
});

test("a mandatory drawn card stays hidden across rerenders until its flight arrives", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadClient(page);
  const view = discardSnapshot();
  await page.evaluate((snapshot) => {
    const client = (globalThis as any).reviewClient;
    client.snapshot = snapshot;
    client.render();
    client.render();
  }, view);
  await expect(page.locator('[data-card-id="drawn-1"]')).toHaveClass(/draw-pending/);
  await expect(page.locator(".draw-card-flight")).toHaveCount(1);
  await page.waitForTimeout(900);
  await expect(page.locator('[data-card-id="drawn-1"]')).not.toHaveClass(/draw-pending/);
});

function battleSnapshot() {
  const duelists = players.slice(0, 2).map((player) => ({
    ...player,
    slots: ["rock", "paper", "scissors"].map((symbol, lane) => ({ occupied: true, hearts: lane + 1, symbol }))
  }));
  return { kind: "match", phase: "battle", roomCode: "CLASH", round: 4, serverNow: 0,
    selfPlayerId: "p0", attackerId: "p0", defenderId: "p1", activeLane: 2, deadlineAt: null,
    players: duelists, self: { hand: ["rock", "paper", "scissors"].map((symbol, index) => ({ symbol, id: `own-${index}` })),
      slotCardIds: ["own-0", "own-1", "own-2"], drawnCardIds: [], discardSelection: [], requiredDiscards: 0,
      extraDrawPurchased: false, noLossBonus: false }, deckCount: 12, outcome: null, matchLog: [],
    battle: { round: 4, duelistIds: ["p0", "p1"], unassignedLost: [0, 0], resultingHp: [10, 10],
      lanes: [0, 1, 2].map((lane) => ({ tripleOverride: false, sides: [
        { playerId: "p0", symbol: "rock", hearts: lane + 1, result: "draw", receivedHp: lane + 1 },
        { playerId: "p1", symbol: "rock", hearts: lane + 1, result: "draw", receivedHp: lane + 1 }
      ] })) } };
}

function discardSnapshot() {
  const duelists = players.slice(0, 2);
  return { kind: "match", phase: "discard", roomCode: "DRAW1", round: 7, serverNow: 0,
    selfPlayerId: "p0", attackerId: "p0", defenderId: "p1", activeLane: 2, deadlineAt: null,
    players: duelists, self: { hand: [
      { symbol: "rock", id: "old-1" }, { symbol: "paper", id: "old-2" },
      { symbol: "scissors", id: "old-3" }, { symbol: "paper", id: "drawn-1" }
    ], slotCardIds: [null, null, null], drawnCardIds: ["drawn-1"], discardSelection: [],
      requiredDiscards: 1, extraDrawPurchased: false, noLossBonus: false },
    battle: null, outcome: null, matchLog: [], deckCount: 11 };
}

function preparationSnapshot() {
  return { kind: "match", phase: "preparation", roomCode: "PHONE", round: 3, serverNow: 0,
    selfPlayerId: "p0", attackerId: "p0", defenderId: "p1", activeLane: 0, deadlineAt: null,
    players: players.slice(0, 2), self: {
      hand: ["rock", "paper", "scissors", "rock", "paper"].map((symbol, index) => ({ symbol, id: `prep-${index}` })),
      slotCardIds: ["prep-0", null, null], drawnCardIds: [], discardSelection: [], requiredDiscards: 0,
      extraDrawPurchased: false, noLossBonus: false
    }, battle: null, outcome: null, matchLog: [], deckCount: 12 };
}

function targetingSnapshot() {
  return { kind: "match", phase: "targeting", roomCode: "PHONE", round: 3, serverNow: 0,
    selfPlayerId: "p0", attackerId: "p0", defenderId: null, activeLane: 0, deadlineAt: null,
    players, self: {
      hand: ["rock", "paper", "scissors"].map((symbol, index) => ({ symbol, id: `target-${index}` })),
      slotCardIds: [null, null, null], drawnCardIds: [], discardSelection: [], requiredDiscards: 0,
      extraDrawPurchased: false, noLossBonus: false
    }, battle: null, outcome: null, matchLog: [], deckCount: 12 };
}

function eliminatedTargetingSnapshot() {
  const tablePlayers = Array.from({ length: 6 }, (_, index) => ({
    ...players[index % players.length]!,
    id: `seat-${index}`,
    name: index === 0 ? "Arb" : `RL-${index}`,
    seatIndex: index,
    hp: index === 0 ? 0 : 5 + index,
    handCount: index === 0 ? 0 : index === 1 ? 5 : 3,
    eliminated: index === 0,
    slots: [{ occupied: false, hearts: 0, symbol: null }, { occupied: false, hearts: 0, symbol: null }, { occupied: false, hearts: 0, symbol: null }]
  }));
  return { ...targetingSnapshot(), selfPlayerId: "seat-0", attackerId: "seat-4", defenderId: "seat-5",
    players: tablePlayers, self: { ...targetingSnapshot().self, hand: [] } };
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 600, height: 800 },
  { width: 768, height: 1250 },
  { width: 844, height: 390 }
]) {
  test(`active match phases stay inside a ${viewport.width}x${viewport.height} mobile viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loadClient(page);
    const snapshots = [targetingSnapshot(), eliminatedTargetingSnapshot(), preparationSnapshot(), battleSnapshot(), {
      ...discardSnapshot(),
      self: {
        ...discardSnapshot().self,
        hand: ["rock", "paper", "scissors", "rock", "paper"].map((symbol, index) => ({ symbol, id: index === 4 ? "drawn-1" : `discard-${index}` }))
      }
    }];
    for (const snapshot of snapshots) {
      const geometry = await page.evaluate((view) => {
        const client = (globalThis as any).reviewClient;
        client.snapshot = view;
        client.render();
        const shell = document.querySelector<HTMLElement>(".match-shell")!;
        const required = shell.querySelectorAll<HTMLElement>(
          ".match-header, .poker-felt, .poker-seat, .duelist-box, .board-card, .player-console, .discard-copy, .discard-hand, .buy-draw, .discard-actions, .opponent-discard-status"
        );
        const clipped = [...required].filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top < -1 || rect.bottom > innerHeight + 1 || rect.left < -1 || rect.right > innerWidth + 1;
        }).map((element) => element.className);
        return {
          phase: (view as any).phase,
          documentOverflow: document.documentElement.scrollHeight - innerHeight,
          shellOverflow: shell.scrollHeight - shell.clientHeight,
          clipped
        };
      }, snapshot);
      expect(geometry, `${geometry.phase} geometry`).toEqual({
        phase: geometry.phase,
        documentOverflow: 0,
        shellOverflow: 0,
        clipped: []
      });
      if ((snapshot as { phase: string }).phase === "preparation") {
        const actions = await page.locator(".phase-actions").boundingBox();
        expect(actions).not.toBeNull();
        expect(viewport.height - actions!.y - actions!.height).toBeLessThan(viewport.height * .15);
        const outlineGap = await page.evaluate(() => {
          const lane = document.querySelector<HTMLElement>(".battle-lane.pair-active")!;
          const duelist = document.querySelector<HTMLElement>(".bottom-duelist")!;
          const laneRect = lane.getBoundingClientRect();
          const bottomInset = Number.parseFloat(getComputedStyle(lane, "::before").bottom);
          return duelist.getBoundingClientRect().top - (laneRect.bottom - bottomInset);
        });
        expect(outlineGap).toBeGreaterThanOrEqual(2);
      }
    }
  });
}

test("phase layout classes leave the desktop match shell sizing unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadClient(page);
  await page.evaluate((snapshot) => {
    const client = (globalThis as any).reviewClient;
    client.snapshot = snapshot;
    client.render();
  }, preparationSnapshot());
  const style = await page.locator(".match-shell").evaluate((element) => {
    const computed = getComputedStyle(element);
    return { position: computed.position, display: computed.display, width: Math.round(element.getBoundingClientRect().width) };
  });
  expect(style).toEqual({ position: "static", display: "block", width: 1252 });
});

for (const viewport of [{ width: 768, height: 1250 }, { width: 1280, height: 900 }]) {
  test(`opponent selection preserves poker geometry at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loadClient(page);
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
    const base = eliminatedTargetingSnapshot();
    const tablePlayers = base.players.map((player, index) => ({ ...player, eliminated: false, hp: 10, handCount: index + 1 }));
    const before = { ...base, selfPlayerId: "seat-0", attackerId: "seat-0", defenderId: null, players: tablePlayers };
    const after = { ...before, defenderId: "seat-5" };
    const measurements = await page.evaluate(([first, second]) => {
      const client = (globalThis as any).reviewClient;
      const capture = (view: unknown) => {
        client.snapshot = view;
        client.render();
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return {
          felt: rect(document.querySelector(".poker-felt")!),
          center: rect(document.querySelector(".target-table-copy")!),
          seats: [...document.querySelectorAll(".poker-seat")].map(rect)
        };
      };
      return [capture(first), capture(second)];
    }, [before, after]);
    expect(measurements[1]).toEqual(measurements[0]);
  });
}
const log = {
  players,
  matchLog: [{ round: 12, attackerId: "p0", defenderId: "p1", players: players.map((player, index) => ({
    playerId: player.id, role: index === 0 ? "attacker" : index === 1 ? "defender" : "idle",
    hpBefore: 20, hpAfter: index === 0 ? 0 : 22, eliminatedAfter: index === 0,
    handCountBefore: 4, handCountAfter: 5, handBeforeDrawDiscard: ["rock", "paper", "scissors"],
    playedCards: ["rock", "paper", "scissors"], hearts: [12, 0, 8], results: ["win", "loss", "draw"],
    receivedHp: [18, 0, 8], drawnCards: ["rock", "paper", "scissors"], discardedCards: ["rock", "paper", "scissors"],
    bonusDraw: true, paidExtraDraw: true
  })) }]
};

for (const width of [375, 768, 1024, 1280]) {
  test(`log cards, stakes and shuffle labels do not overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await loadClient(page);
    await page.evaluate((view) => {
      const client = (globalThis as any).reviewClient;
      document.querySelector("#app")!.innerHTML = client.matchLogOverlay(view);
      document.querySelector<HTMLDialogElement>("dialog")!.showModal();
    }, log);
    const overlaps = await page.evaluate(() => {
      const overlap = (a: Element, b: Element): boolean => {
        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
        return Math.min(x.right, y.right) - Math.max(x.left, y.left) > 0.5
          && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 0.5;
      };
      return [...document.querySelectorAll(".log-battle-card")].map((card) => overlap(card.querySelector(".log-card-heart")!, card.querySelector(".log-card-icon")!))
        .concat([...document.querySelectorAll(".log-resolve-shuffle")].map((shuffle) => overlap(shuffle.querySelector("div:first-child > span")!, shuffle.querySelector(".log-section-label")!)));
    });
    expect(overlaps.every((overlap) => !overlap)).toBe(true);
    await expect(page.getByRole("dialog", { name: "Match log" })).toBeVisible();
  });
}

test("a snapshot preserves focused controls and keyboard placement emits once", async ({ page }) => {
  await loadClient(page);
  const view = { kind: "match", phase: "preparation", roomCode: "TEST1", round: 1,
    selfPlayerId: "p0", attackerId: "p0", defenderId: "p1", activeLane: 0, deadlineAt: null,
    players, self: { hand: ["rock", "paper", "scissors"].map((symbol) => ({ symbol, id: `${symbol}-1` })),
      slotCardIds: ["rock-1", null, null], drawnCardIds: [], discardSelection: [] },
    battle: null, outcome: null, matchLog: [], deckCount: 12 };
  await page.evaluate((snapshot) => { const c = (globalThis as any).reviewClient; c.snapshot = snapshot; c.render(); }, view);
  await page.locator('[data-heart="1"]').focus();
  expect(await page.evaluate(() => {
    const before = document.activeElement;
    (globalThis as any).reviewClient.render();
    return before === document.activeElement;
  })).toBe(true);
  await page.evaluate(() => {
    const client = (globalThis as any).reviewClient;
    client.snapshot.players[0].slots[0] = { occupied: false, hearts: 0, symbol: null };
    client.snapshot.self.slotCardIds = [null, null, null];
    client.render();
  });
  await page.locator('[data-card-id="paper-1"]').click();
  await page.locator('[data-drop-slot="0"]').focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (globalThis as any).emitted.filter((entry: string[]) => entry[0] === "match:place"))).toEqual([
    ["match:place", { slotIndex: 0, cardId: "paper-1" }]
  ]);
});
