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
