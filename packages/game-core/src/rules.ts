import { createDeck, shuffle } from "./random.js";
import {
  CARD_SYMBOLS,
  DEFAULT_GAME_CONFIG,
  RuleError,
  type BattleLane,
  type BattleSide,
  type BattleSlot,
  type BattleSummary,
  type Card,
  type CardSymbol,
  type GameConfig,
  type LaneResult,
  type MatchOutcome,
  type MatchState,
  type PreparationLane,
  type PlayerId,
  type PlayerSetup,
  type PlayerState,
  type RandomSource,
  type ThreeSlots
} from "./types.js";

const EMPTY_SLOTS = (): ThreeSlots => [
  { cardId: null, hearts: 0 },
  { cardId: null, hearts: 0 },
  { cardId: null, hearts: 0 }
];

function createPlayer(setup: PlayerSetup, config: GameConfig): PlayerState {
  return {
    id: setup.id,
    name: setup.name,
    isBot: setup.isBot ?? false,
    hp: config.startingHp,
    hand: [],
    slots: EMPTY_SLOTS(),
    locked: false,
    requiredDiscards: 0,
    discardSelection: [],
    drawnCardIds: [],
    extraDrawPurchased: false,
    noLossBonus: false,
    rematchRequested: false
  };
}

function drawOne(state: MatchState): Card {
  const card = state.deck.pop();
  if (!card) {
    throw new RuleError("The mutual deck does not contain enough cards.");
  }
  return card;
}

function playerIndex(state: MatchState, playerId: PlayerId): 0 | 1 {
  if (state.players[0].id === playerId) return 0;
  if (state.players[1].id === playerId) return 1;
  throw new RuleError("Player is not part of this match.");
}

function playerCard(player: PlayerState, cardId: string | null): Card | null {
  if (!cardId) return null;
  return player.hand.find((card) => card.id === cardId) ?? null;
}

function requireActionablePlayer(
  state: MatchState,
  playerId: PlayerId,
  phase: "preparation" | "discard"
): PlayerState {
  if (state.phase !== phase) {
    throw new RuleError(`Action is only valid during the ${phase} phase.`);
  }
  const player = state.players[playerIndex(state, playerId)];
  if (player.locked) {
    throw new RuleError("Player has already locked this phase.");
  }
  return player;
}

export function createMatch(
  id: string,
  setups: [PlayerSetup, PlayerSetup],
  now: number,
  random: RandomSource = Math.random,
  configOverrides: Partial<GameConfig> = {}
): MatchState {
  const config: GameConfig = { ...DEFAULT_GAME_CONFIG, ...configOverrides };
  const state: MatchState = {
    id,
    round: 1,
    preparationLane: 0,
    phase: "preparation",
    deadlineAt: now + config.preparationMs,
    deck: shuffle(createDeck(config), random),
    players: [createPlayer(setups[0], config), createPlayer(setups[1], config)],
    battle: null,
    outcome: null,
    config
  };

  for (let drawIndex = 0; drawIndex < config.startingHandSize; drawIndex += 1) {
    state.players[0].hand.push(drawOne(state));
    state.players[1].hand.push(drawOne(state));
  }

  return state;
}

export function setCardPlacement(
  state: MatchState,
  playerId: PlayerId,
  slotIndex: number,
  cardId: string | null
): void {
  const player = requireActionablePlayer(state, playerId, "preparation");
  if (slotIndex !== state.preparationLane) {
    throw new RuleError("Only the current battle pair can be changed.");
  }
  const slot = player.slots[slotIndex];
  if (!slot) throw new RuleError("Battle position does not exist.");

  if (cardId !== null && !player.hand.some((card) => card.id === cardId)) {
    throw new RuleError("Card is not in the player's hand.");
  }

  if (cardId !== null) {
    const previousIndex = player.slots.findIndex((candidate) => candidate.cardId === cardId);
    const previous = previousIndex >= 0 ? player.slots[previousIndex] : null;
    if (previous && previous !== slot) {
      if (previousIndex < state.preparationLane) {
        throw new RuleError("That card is already committed to a revealed pair.");
      }
      previous.cardId = null;
      previous.hearts = 0;
    }
  }

  slot.cardId = cardId;
  if (cardId === null) {
    slot.hearts = 0;
  } else if (state.preparationLane === 2) {
    slot.hearts = player.hp - player.slots[0].hearts - player.slots[1].hearts;
  }
}

export function adjustSlotHearts(
  state: MatchState,
  playerId: PlayerId,
  slotIndex: number,
  delta: number
): void {
  const player = requireActionablePlayer(state, playerId, "preparation");
  if (slotIndex !== state.preparationLane) {
    throw new RuleError("Only the current battle pair can receive HP.");
  }
  if (state.preparationLane === 2) {
    throw new RuleError("The final pair automatically receives all remaining HP.");
  }
  const slot = player.slots[slotIndex];
  if (!slot) throw new RuleError("Battle position does not exist.");
  if (!slot.cardId) throw new RuleError("HP can only be placed on an occupied position.");
  if (!Number.isInteger(delta) || delta === 0) {
    throw new RuleError("HP adjustment must be a non-zero whole number.");
  }

  const allocated = player.slots.reduce((total, current) => total + current.hearts, 0);
  const next = slot.hearts + delta;
  const nextAllocated = allocated + delta;
  if (next < 0 || nextAllocated > player.hp) {
    throw new RuleError("HP allocation is outside the available range.");
  }
  slot.hearts = next;
}

export function setDiscardSelection(
  state: MatchState,
  playerId: PlayerId,
  cardIds: readonly string[]
): void {
  const player = requireActionablePlayer(state, playerId, "discard");
  const unique = [...new Set(cardIds)];
  if (unique.length !== cardIds.length || unique.length > player.requiredDiscards) {
    throw new RuleError("Discard selection has the wrong number of unique cards.");
  }
  if (unique.some((cardId) => !player.hand.some((card) => card.id === cardId))) {
    throw new RuleError("Discard selection contains a card outside the player's hand.");
  }
  player.discardSelection = unique;
}

export function lockPlayer(state: MatchState, playerId: PlayerId): void {
  if (state.phase !== "preparation" && state.phase !== "discard") {
    throw new RuleError("This phase cannot be locked.");
  }
  const player = state.players[playerIndex(state, playerId)];
  if (player.locked) return;
  if (
    state.phase === "discard" &&
    player.discardSelection.length !== player.requiredDiscards
  ) {
    throw new RuleError("Select every required discard before locking.");
  }
  player.locked = true;
}

export function allPlayersLocked(state: MatchState): boolean {
  return state.players.every((player) => player.locked);
}

export function advancePreparationPair(
  state: MatchState,
  now: number
): BattleSummary | null {
  if (state.phase !== "preparation") {
    throw new RuleError("Only preparation pairs can advance.");
  }
  if (state.preparationLane < 2) {
    state.preparationLane = (state.preparationLane + 1) as PreparationLane;
    state.deadlineAt = now + state.config.preparationMs;
    for (const player of state.players) player.locked = false;
    return null;
  }
  return resolvePreparation(state, now);
}

function isTriple(player: PlayerState): boolean {
  const cards = player.slots.map((slot) => playerCard(player, slot.cardId));
  const first = cards[0];
  if (!first) return false;
  return cards.every((card) => card !== null && card.symbol === first.symbol);
}

export function compareSymbols(left: CardSymbol, right: CardSymbol): LaneResult {
  if (left === right) return "draw";
  if (
    (left === "rock" && right === "scissors") ||
    (left === "scissors" && right === "paper") ||
    (left === "paper" && right === "rock")
  ) {
    return "win";
  }
  return "loss";
}

function oppositeResult(result: LaneResult): LaneResult {
  if (result === "win") return "loss";
  if (result === "loss") return "win";
  return "draw";
}

function laneResults(
  leftCard: Card | null,
  rightCard: Card | null,
  leftTriple: boolean,
  rightTriple: boolean
): [LaneResult, LaneResult, boolean] {
  if (!leftCard && !rightCard) return ["loss", "loss", false];
  if (!leftCard) return ["loss", "win", false];
  if (!rightCard) return ["win", "loss", false];

  const normal = compareSymbols(leftCard.symbol, rightCard.symbol);
  if (normal !== "draw") return [normal, oppositeResult(normal), false];
  if (leftTriple && !rightTriple) return ["win", "loss", true];
  if (rightTriple && !leftTriple) return ["loss", "win", true];
  return ["draw", "draw", false];
}

function receivedHp(result: LaneResult, own: number, opposing: number): number {
  if (result === "loss") return 0;
  if (result === "draw") return own;
  return own + Math.max(opposing - 1, 0);
}

export function resolvePreparation(state: MatchState, now: number): BattleSummary {
  if (state.phase !== "preparation") {
    throw new RuleError("Preparation can only resolve from the preparation phase.");
  }
  if (state.preparationLane !== 2) {
    throw new RuleError("All three pairs must be prepared before battle resolution.");
  }

  for (const player of state.players) {
    if (player.slots[2].cardId !== null) {
      player.slots[2].hearts = player.hp - player.slots[0].hearts - player.slots[1].hearts;
    }
  }

  const triples: [boolean, boolean] = [isTriple(state.players[0]), isTriple(state.players[1])];
  const unassignedLost: [number, number] = state.players.map((player) => {
    const allocated = player.slots.reduce((total, slot) => total + slot.hearts, 0);
    return player.hp - allocated;
  }) as [number, number];
  const totals: [number, number] = [0, 0];
  const laneList: BattleLane[] = [];

  for (let laneIndex = 0; laneIndex < 3; laneIndex += 1) {
    const leftSlot = state.players[0].slots[laneIndex]!;
    const rightSlot = state.players[1].slots[laneIndex]!;
    const leftCard = playerCard(state.players[0], leftSlot.cardId);
    const rightCard = playerCard(state.players[1], rightSlot.cardId);
    const [leftResult, rightResult, tripleOverride] = laneResults(
      leftCard,
      rightCard,
      triples[0],
      triples[1]
    );
    const leftReceived = receivedHp(leftResult, leftSlot.hearts, rightSlot.hearts);
    const rightReceived = receivedHp(rightResult, rightSlot.hearts, leftSlot.hearts);
    totals[0] += leftReceived;
    totals[1] += rightReceived;

    const sides: [BattleSide, BattleSide] = [
      {
        playerId: state.players[0].id,
        card: leftCard,
        hearts: leftSlot.hearts,
        result: leftResult,
        receivedHp: leftReceived
      },
      {
        playerId: state.players[1].id,
        card: rightCard,
        hearts: rightSlot.hearts,
        result: rightResult,
        receivedHp: rightReceived
      }
    ];
    laneList.push({ index: laneIndex, sides, tripleOverride });
  }

  state.players[0].hp = totals[0];
  state.players[1].hp = totals[1];
  const noLoss: [boolean, boolean] = [
    laneList.every((lane) => lane.sides[0].result !== "loss"),
    laneList.every((lane) => lane.sides[1].result !== "loss")
  ];
  state.players[0].noLossBonus = noLoss[0];
  state.players[1].noLossBonus = noLoss[1];

  const summary: BattleSummary = {
    round: state.round,
    lanes: laneList as [BattleLane, BattleLane, BattleLane],
    unassignedLost,
    noLoss,
    resultingHp: totals
  };
  state.battle = summary;

  if (totals[0] === 0 || totals[1] === 0) {
    state.phase = "finished";
    state.deadlineAt = null;
    state.outcome = totals[0] === 0 && totals[1] === 0
      ? { kind: "draw", winnerId: null, reason: "hp" }
      : {
          kind: "winner",
          winnerId: totals[0] === 0 ? state.players[1].id : state.players[0].id,
          reason: "hp"
        };
  } else {
    state.phase = "battle";
    state.deadlineAt = now + state.config.battleRevealMs;
  }

  return summary;
}

export function startDiscardPhase(
  state: MatchState,
  now: number
): void {
  if (state.phase !== "battle") {
    throw new RuleError("Discard phase can only begin after a surviving battle.");
  }

  const drawCounts: [number, number] = [
    state.players[0].noLossBonus ? 2 : 1,
    state.players[1].noLossBonus ? 2 : 1
  ];

  for (let playerOffset = 0; playerOffset < 2; playerOffset += 1) {
    const player = state.players[playerOffset as 0 | 1];
    const originalSize = player.hand.length;
    player.drawnCardIds = [];
    for (let drawIndex = 0; drawIndex < drawCounts[playerOffset]!; drawIndex += 1) {
      const card = drawOne(state);
      player.hand.push(card);
      player.drawnCardIds.push(card.id);
    }
    player.requiredDiscards = player.noLossBonus && originalSize >= state.config.maximumHandSize
      ? 2
      : 1;
    player.discardSelection = [];
    player.locked = false;
    player.extraDrawPurchased = false;
    player.slots = EMPTY_SLOTS();
  }

  state.phase = "discard";
  state.deadlineAt = now + state.config.discardMs;
}

export function purchaseExtraDraw(state: MatchState, playerId: PlayerId): Card {
  const player = requireActionablePlayer(state, playerId, "discard");
  if (player.extraDrawPurchased) {
    throw new RuleError("The extra draw has already been purchased this shuffle phase.");
  }
  if (player.hp <= 1) {
    throw new RuleError("At least 2 HP is required to purchase an extra draw.");
  }
  const card = drawOne(state);
  player.hp -= 1;
  player.hand.push(card);
  player.drawnCardIds.push(card.id);
  player.requiredDiscards += 1;
  player.extraDrawPurchased = true;
  return card;
}

export function autoCompleteDiscards(state: MatchState): void {
  if (state.phase !== "discard") {
    throw new RuleError("Automatic discard is only valid during the discard phase.");
  }
  for (const player of state.players) {
    if (player.locked) continue;
    const selected = player.discardSelection.filter((cardId) =>
      player.hand.some((card) => card.id === cardId)
    );
    const preferred = [...player.drawnCardIds].reverse();
    const fallback = [...player.hand].reverse().map((card) => card.id);
    for (const cardId of [...preferred, ...fallback]) {
      if (selected.length >= player.requiredDiscards) break;
      if (!selected.includes(cardId)) selected.push(cardId);
    }
    player.discardSelection = selected;
    player.locked = true;
  }
}

export function fiveOfAKind(player: PlayerState): CardSymbol | null {
  if (player.hand.length !== 5) return null;
  const symbol = player.hand[0]?.symbol;
  if (!symbol) return null;
  return player.hand.every((card) => card.symbol === symbol) ? symbol : null;
}

function showdownOutcome(
  state: MatchState,
  symbols: [CardSymbol | null, CardSymbol | null]
): MatchOutcome | null {
  if (!symbols[0] && !symbols[1]) return null;
  if (symbols[0] && !symbols[1]) {
    return { kind: "winner", winnerId: state.players[0].id, reason: "showdown", showdownSymbols: symbols };
  }
  if (!symbols[0] && symbols[1]) {
    return { kind: "winner", winnerId: state.players[1].id, reason: "showdown", showdownSymbols: symbols };
  }
  const result = compareSymbols(symbols[0]!, symbols[1]!);
  if (result === "draw") {
    return { kind: "draw", winnerId: null, reason: "showdown", showdownSymbols: symbols };
  }
  return {
    kind: "winner",
    winnerId: result === "win" ? state.players[0].id : state.players[1].id,
    reason: "showdown",
    showdownSymbols: symbols
  };
}

export function finalizeDiscards(
  state: MatchState,
  now: number,
  random: RandomSource = Math.random
): MatchOutcome | null {
  if (state.phase !== "discard") {
    throw new RuleError("Discards can only resolve during the discard phase.");
  }
  if (!allPlayersLocked(state)) {
    throw new RuleError("Both players must lock before discards resolve.");
  }

  const returned: Card[] = [];
  for (const player of state.players) {
    if (player.discardSelection.length !== player.requiredDiscards) {
      throw new RuleError("A player has not selected the required number of discards.");
    }
    const discardSet = new Set(player.discardSelection);
    returned.push(...player.hand.filter((card) => discardSet.has(card.id)));
    player.hand = player.hand.filter((card) => !discardSet.has(card.id));
  }

  const symbols: [CardSymbol | null, CardSymbol | null] = [
    fiveOfAKind(state.players[0]),
    fiveOfAKind(state.players[1])
  ];
  const outcome = showdownOutcome(state, symbols);
  if (outcome) {
    state.deck = [...state.deck, ...returned];
    state.outcome = outcome;
    state.phase = "finished";
    state.deadlineAt = null;
    return outcome;
  }

  state.deck = shuffle([...state.deck, ...returned], random);
  state.round += 1;
  state.phase = "preparation";
  state.preparationLane = 0;
  state.deadlineAt = now + state.config.preparationMs;
  state.battle = null;
  for (const player of state.players) {
    player.slots = EMPTY_SLOTS();
    player.locked = false;
    player.requiredDiscards = 0;
    player.discardSelection = [];
    player.drawnCardIds = [];
    player.extraDrawPurchased = false;
    player.noLossBonus = false;
  }
  return null;
}

export function forfeitMatch(state: MatchState, forfeitingIds: readonly PlayerId[]): void {
  const forfeits = new Set(forfeitingIds);
  const active = state.players.filter((player) => !forfeits.has(player.id));
  state.phase = "finished";
  state.deadlineAt = null;
  state.outcome = active.length === 1
    ? { kind: "winner", winnerId: active[0]!.id, reason: "forfeit" }
    : { kind: "draw", winnerId: null, reason: "forfeit" };
}

export function countAllCards(state: MatchState): number {
  return state.deck.length + state.players.reduce((total, player) => total + player.hand.length, 0);
}

export function assertMatchInvariants(state: MatchState): void {
  const expectedCards = CARD_SYMBOLS.length * state.config.copiesPerSymbol;
  if (countAllCards(state) !== expectedCards) {
    throw new RuleError(`Expected ${expectedCards} cards across deck and hands.`);
  }
  const ids = [...state.deck, ...state.players.flatMap((player) => player.hand)].map((card) => card.id);
  if (new Set(ids).size !== ids.length) throw new RuleError("A card instance exists in more than one place.");
  for (const player of state.players) {
    if (!Number.isInteger(player.hp) || player.hp < 0) throw new RuleError("Player HP is invalid.");
    if (state.phase === "preparation" && player.hand.length > state.config.maximumHandSize) {
      throw new RuleError("Preparation began with a hand above the maximum size.");
    }
    const placed = player.slots.map((slot) => slot.cardId).filter((id): id is string => id !== null);
    if (new Set(placed).size !== placed.length) throw new RuleError("A card occupies multiple positions.");
    if (placed.some((id) => !player.hand.some((card) => card.id === id))) {
      throw new RuleError("A placed card does not belong to the player.");
    }
    if (player.slots.some((slot) => slot.hearts < 0 || !Number.isInteger(slot.hearts))) {
      throw new RuleError("A slot contains invalid HP.");
    }
  }
}
