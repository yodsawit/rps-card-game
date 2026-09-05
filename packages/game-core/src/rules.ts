import { createDeck, shuffle } from "./random.js";
import {
  CARD_SYMBOLS,
  DEFAULT_GAME_CONFIG,
  MAX_SEATS,
  MIN_SEATS,
  RuleError,
  type BattleLane,
  type BattleSide,
  type BattleSummary,
  type Card,
  type CardSymbol,
  type GameConfig,
  type LaneResult,
  type MatchOutcome,
  type MatchState,
  type PlayerId,
  type PlayerSetup,
  type PlayerState,
  type PreparationLane,
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
    rematchRequested: false,
    eliminated: false
  };
}

function drawOne(state: MatchState): Card {
  const card = state.deck.pop();
  if (!card) throw new RuleError("The mutual deck does not contain enough cards.");
  return card;
}

function playerById(state: MatchState, playerId: PlayerId): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new RuleError("Player is not part of this match.");
  return player;
}

function playerCard(player: PlayerState, cardId: string | null): Card | null {
  if (!cardId) return null;
  return player.hand.find((card) => card.id === cardId) ?? null;
}

export function activeDuelists(state: MatchState): [PlayerState, PlayerState] {
  if (!state.defenderId) throw new RuleError("No opponent has been selected for this turn.");
  return [playerById(state, state.attackerId), playerById(state, state.defenderId)];
}

function isDuelist(state: MatchState, playerId: PlayerId): boolean {
  return playerId === state.attackerId || playerId === state.defenderId;
}

function requireActionablePlayer(
  state: MatchState,
  playerId: PlayerId,
  phase: "preparation" | "discard"
): PlayerState {
  if (state.phase !== phase) {
    throw new RuleError(`Action is only valid during the ${phase} phase.`);
  }
  if (!isDuelist(state, playerId)) {
    throw new RuleError("Only the two active duelists can act during this phase.");
  }
  const player = playerById(state, playerId);
  if (player.eliminated) throw new RuleError("An eliminated player cannot act.");
  if (player.locked) throw new RuleError("Player has already locked this phase.");
  return player;
}

function resetTurnState(player: PlayerState): void {
  player.slots = EMPTY_SLOTS();
  player.locked = false;
  player.requiredDiscards = 0;
  player.discardSelection = [];
  player.drawnCardIds = [];
  player.extraDrawPurchased = false;
  player.noLossBonus = false;
}

export function createMatch(
  id: string,
  setups: readonly PlayerSetup[],
  now: number,
  random: RandomSource = Math.random,
  configOverrides: Partial<GameConfig> = {}
): MatchState {
  if (setups.length < MIN_SEATS || setups.length > MAX_SEATS) {
    throw new RuleError(`A match requires ${MIN_SEATS} to ${MAX_SEATS} seats.`);
  }
  if (new Set(setups.map((setup) => setup.id)).size !== setups.length) {
    throw new RuleError("Every seat must have a unique player ID.");
  }

  const config: GameConfig = {
    ...DEFAULT_GAME_CONFIG,
    ...configOverrides,
    copiesPerSymbol: setups.length + 4
  };
  const players = setups.map((setup) => createPlayer(setup, config));
  const state: MatchState = {
    id,
    round: 1,
    preparationLane: 0,
    phase: "targeting",
    deadlineAt: now + config.targetSelectionMs,
    deck: shuffle(createDeck(config), random),
    players,
    attackerId: players[0]!.id,
    defenderId: null,
    battle: null,
    outcome: null,
    config
  };

  for (let drawIndex = 0; drawIndex < config.startingHandSize; drawIndex += 1) {
    for (const player of state.players) player.hand.push(drawOne(state));
  }

  return state;
}

export function livingPlayers(state: MatchState): PlayerState[] {
  return state.players.filter((player) => !player.eliminated);
}

export function clockwiseOpponentId(state: MatchState): PlayerId {
  const attackerIndex = state.players.findIndex((player) => player.id === state.attackerId);
  if (attackerIndex < 0) throw new RuleError("The active attacker is not seated.");
  for (let offset = 1; offset < state.players.length; offset += 1) {
    const candidate = state.players[(attackerIndex + offset) % state.players.length]!;
    if (!candidate.eliminated) return candidate.id;
  }
  throw new RuleError("No living opponent is available.");
}

export function selectOpponent(
  state: MatchState,
  playerId: PlayerId,
  opponentId: PlayerId,
  now: number
): void {
  if (state.phase !== "targeting") {
    throw new RuleError("An opponent can only be selected at the start of a turn.");
  }
  if (playerId !== state.attackerId) throw new RuleError("Only the active attacker can select an opponent.");
  const attacker = playerById(state, playerId);
  const defender = playerById(state, opponentId);
  if (attacker.eliminated) throw new RuleError("An eliminated player cannot attack.");
  if (defender.eliminated || defender.id === attacker.id) {
    throw new RuleError("Select a different living opponent.");
  }

  for (const player of state.players) resetTurnState(player);
  state.defenderId = defender.id;
  state.preparationLane = 0;
  state.phase = "preparation";
  state.deadlineAt = now + state.config.preparationMs;
  state.battle = null;
}

export function setCardPlacement(
  state: MatchState,
  playerId: PlayerId,
  slotIndex: number,
  cardId: string
): void {
  const player = requireActionablePlayer(state, playerId, "preparation");
  if (slotIndex !== state.preparationLane) {
    throw new RuleError("Only the current battle pair can be committed.");
  }
  const slot = player.slots[slotIndex];
  if (!slot) throw new RuleError("Battle position does not exist.");
  if (slot.cardId !== null) {
    if (slot.cardId === cardId) return;
    throw new RuleError("A placed card cannot be replaced or retracted.");
  }
  if (!player.hand.some((card) => card.id === cardId)) {
    throw new RuleError("Card is not in the player's hand.");
  }
  if (player.slots.some((candidate) => candidate.cardId === cardId)) {
    throw new RuleError("That card is already committed to this duel.");
  }

  slot.cardId = cardId;
  if (state.preparationLane === 2) {
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
  if (!Number.isInteger(delta) || delta <= 0) {
    throw new RuleError("Committed HP can only increase by a positive whole number.");
  }

  const allocated = player.slots.reduce((total, current) => total + current.hearts, 0);
  if (allocated + delta > player.hp) {
    throw new RuleError("HP allocation is outside the available range.");
  }
  slot.hearts += delta;
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
  if (!isDuelist(state, playerId)) throw new RuleError("Only an active duelist can lock.");
  const player = playerById(state, playerId);
  if (player.locked) return;
  if (state.phase === "discard" && player.discardSelection.length !== player.requiredDiscards) {
    throw new RuleError("Select every required discard before locking.");
  }
  player.locked = true;
}

export function duelistsLocked(state: MatchState): boolean {
  if (!state.defenderId) return false;
  return activeDuelists(state).every((player) => player.locked);
}

export function autoCompletePreparationPair(state: MatchState): void {
  if (state.phase !== "preparation") {
    throw new RuleError("Automatic card placement is only valid during preparation.");
  }
  for (const player of activeDuelists(state)) {
    const slot = player.slots[state.preparationLane];
    if (slot.cardId !== null) continue;
    const leftmost = player.hand.find((card) =>
      !player.slots.some((candidate) => candidate.cardId === card.id)
    );
    if (!leftmost) continue;
    slot.cardId = leftmost.id;
    if (state.preparationLane === 2) {
      slot.hearts = player.hp - player.slots[0].hearts - player.slots[1].hearts;
    }
  }
}

/** Backward-compatible name; in group matches it means both current duelists. */
export function allPlayersLocked(state: MatchState): boolean {
  return duelistsLocked(state);
}

export function advancePreparationPair(
  state: MatchState,
  now: number,
  random: RandomSource = Math.random
): BattleSummary | null {
  if (state.phase !== "preparation") {
    throw new RuleError("Only preparation pairs can advance.");
  }
  if (state.preparationLane < 2) {
    state.preparationLane = (state.preparationLane + 1) as PreparationLane;
    state.deadlineAt = now + state.config.preparationMs;
    for (const player of activeDuelists(state)) player.locked = false;
    return null;
  }
  return resolvePreparation(state, now, random);
}

function isTriple(player: PlayerState): boolean {
  const cards = player.slots.map((slot) => playerCard(player, slot.cardId));
  const first = cards[0];
  return Boolean(first && cards.every((card) => card !== null && card.symbol === first.symbol));
}

export function compareSymbols(left: CardSymbol, right: CardSymbol): LaneResult {
  if (left === right) return "draw";
  if (
    (left === "rock" && right === "scissors")
    || (left === "scissors" && right === "paper")
    || (left === "paper" && right === "rock")
  ) return "win";
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

function recycleEliminatedCards(state: MatchState, random: RandomSource): void {
  const returned: Card[] = [];
  for (const player of state.players) {
    if (!player.eliminated || player.hand.length === 0) continue;
    returned.push(...player.hand);
    player.hand = [];
    resetTurnState(player);
  }
  if (returned.length > 0) state.deck = shuffle([...state.deck, ...returned], random);
}

function setLastPlayerOutcome(state: MatchState, reason: "hp" | "forfeit"): boolean {
  const living = livingPlayers(state);
  if (living.length > 1) return false;
  state.phase = "finished";
  state.deadlineAt = null;
  state.outcome = living.length === 1
    ? { kind: "winner", winnerId: living[0]!.id, reason }
    : { kind: "draw", winnerId: null, reason };
  return true;
}

export function resolvePreparation(
  state: MatchState,
  now: number,
  random: RandomSource = Math.random
): BattleSummary {
  if (state.phase !== "preparation" || state.preparationLane !== 2) {
    throw new RuleError("All three pairs must be prepared before battle resolution.");
  }
  const duelists = activeDuelists(state);
  for (const player of duelists) {
    if (player.slots[2].cardId !== null) {
      player.slots[2].hearts = player.hp - player.slots[0].hearts - player.slots[1].hearts;
    }
  }

  const triples: [boolean, boolean] = [isTriple(duelists[0]), isTriple(duelists[1])];
  const unassignedLost = duelists.map((player) =>
    player.hp - player.slots.reduce((total, slot) => total + slot.hearts, 0)
  ) as [number, number];
  const totals: [number, number] = [0, 0];
  const laneList: BattleLane[] = [];

  for (let laneIndex = 0; laneIndex < 3; laneIndex += 1) {
    const leftSlot = duelists[0].slots[laneIndex]!;
    const rightSlot = duelists[1].slots[laneIndex]!;
    const leftCard = playerCard(duelists[0], leftSlot.cardId);
    const rightCard = playerCard(duelists[1], rightSlot.cardId);
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
      { playerId: duelists[0].id, card: leftCard, hearts: leftSlot.hearts, result: leftResult, receivedHp: leftReceived },
      { playerId: duelists[1].id, card: rightCard, hearts: rightSlot.hearts, result: rightResult, receivedHp: rightReceived }
    ];
    laneList.push({ index: laneIndex, sides, tripleOverride });
  }

  duelists[0].hp = totals[0];
  duelists[1].hp = totals[1];
  const noLoss: [boolean, boolean] = [
    laneList.every((lane) => lane.sides[0].result !== "loss"),
    laneList.every((lane) => lane.sides[1].result !== "loss")
  ];
  duelists[0].noLossBonus = noLoss[0];
  duelists[1].noLossBonus = noLoss[1];
  const eliminatedIds = duelists.filter((player) => player.hp === 0).map((player) => player.id);
  for (const player of duelists) player.eliminated = player.hp === 0;

  const summary: BattleSummary = {
    round: state.round,
    duelistIds: [duelists[0].id, duelists[1].id],
    lanes: laneList as [BattleLane, BattleLane, BattleLane],
    unassignedLost,
    noLoss,
    resultingHp: totals,
    eliminatedIds
  };
  state.battle = summary;
  recycleEliminatedCards(state, random);

  if (!setLastPlayerOutcome(state, "hp")) {
    state.phase = "battle";
    state.deadlineAt = now + state.config.battleRevealMs;
  }
  return summary;
}

function beginNextTurn(state: MatchState, now: number): void {
  const currentIndex = state.players.findIndex((player) => player.id === state.attackerId);
  if (currentIndex < 0) throw new RuleError("The active attacker is not seated.");
  if (setLastPlayerOutcome(state, "hp")) return;
  let next: PlayerState | null = null;
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(currentIndex + offset) % state.players.length]!;
    if (!candidate.eliminated) {
      next = candidate;
      break;
    }
  }
  if (!next) throw new RuleError("No living attacker is available.");
  for (const player of state.players) resetTurnState(player);
  state.round += 1;
  state.attackerId = next.id;
  state.defenderId = null;
  state.preparationLane = 0;
  state.phase = "targeting";
  state.deadlineAt = now + state.config.targetSelectionMs;
  state.battle = null;
  state.outcome = null;
}

export function startDiscardPhase(state: MatchState, now: number): void {
  if (state.phase !== "battle" || !state.battle) {
    throw new RuleError("Discard phase can only begin after a surviving battle.");
  }
  if (state.battle.eliminatedIds.length > 0) {
    throw new RuleError("A duel with an elimination skips the shuffle phase.");
  }
  const duelists = activeDuelists(state);
  const drawCounts: [number, number] = [
    duelists[0].noLossBonus ? 2 : 1,
    duelists[1].noLossBonus ? 2 : 1
  ];
  for (let index = 0; index < 2; index += 1) {
    const player = duelists[index]!;
    const originalSize = player.hand.length;
    player.drawnCardIds = [];
    for (let drawIndex = 0; drawIndex < drawCounts[index]!; drawIndex += 1) {
      const card = drawOne(state);
      player.hand.push(card);
      player.drawnCardIds.push(card.id);
    }
    player.requiredDiscards = player.noLossBonus && originalSize >= state.config.maximumHandSize ? 2 : 1;
    player.discardSelection = [];
    player.locked = false;
    player.extraDrawPurchased = false;
    player.slots = EMPTY_SLOTS();
  }
  state.phase = "discard";
  state.deadlineAt = now + state.config.discardMs;
}

export function advanceBattle(state: MatchState, now: number): void {
  if (state.phase !== "battle" || !state.battle) {
    throw new RuleError("Only a completed battle can advance.");
  }
  if (state.battle.eliminatedIds.length > 0) beginNextTurn(state, now);
  else startDiscardPhase(state, now);
}

export function purchaseExtraDraw(state: MatchState, playerId: PlayerId): Card {
  const player = requireActionablePlayer(state, playerId, "discard");
  if (player.extraDrawPurchased) {
    throw new RuleError("The extra draw has already been purchased this shuffle phase.");
  }
  if (player.hp <= 1) throw new RuleError("At least 2 HP is required to purchase an extra draw.");
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
  for (const player of activeDuelists(state)) {
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
  return symbol && player.hand.every((card) => card.symbol === symbol) ? symbol : null;
}

function showdownOutcome(
  duelists: [PlayerState, PlayerState],
  symbols: [CardSymbol | null, CardSymbol | null]
): MatchOutcome | null {
  if (!symbols[0] && !symbols[1]) return null;
  if (symbols[0] && !symbols[1]) {
    return { kind: "winner", winnerId: duelists[0].id, reason: "showdown", showdownSymbols: symbols };
  }
  if (!symbols[0] && symbols[1]) {
    return { kind: "winner", winnerId: duelists[1].id, reason: "showdown", showdownSymbols: symbols };
  }
  const result = compareSymbols(symbols[0]!, symbols[1]!);
  if (result === "draw") return { kind: "draw", winnerId: null, reason: "showdown", showdownSymbols: symbols };
  return {
    kind: "winner",
    winnerId: result === "win" ? duelists[0].id : duelists[1].id,
    reason: "showdown",
    showdownSymbols: symbols
  };
}

export function finalizeDiscards(
  state: MatchState,
  now: number,
  random: RandomSource = Math.random
): MatchOutcome | null {
  if (state.phase !== "discard") throw new RuleError("Discards can only resolve during the discard phase.");
  if (!duelistsLocked(state)) throw new RuleError("Both duelists must lock before discards resolve.");
  const duelists = activeDuelists(state);
  const returned: Card[] = [];
  for (const player of duelists) {
    if (player.discardSelection.length !== player.requiredDiscards) {
      throw new RuleError("A player has not selected the required number of discards.");
    }
    const discardSet = new Set(player.discardSelection);
    returned.push(...player.hand.filter((card) => discardSet.has(card.id)));
    player.hand = player.hand.filter((card) => !discardSet.has(card.id));
  }

  const symbols: [CardSymbol | null, CardSymbol | null] = [
    fiveOfAKind(duelists[0]),
    fiveOfAKind(duelists[1])
  ];
  const outcome = showdownOutcome(duelists, symbols);
  state.deck = shuffle([...state.deck, ...returned], random);
  if (outcome) {
    state.outcome = outcome;
    state.phase = "finished";
    state.deadlineAt = null;
    return outcome;
  }
  beginNextTurn(state, now);
  return null;
}

export function forfeitPlayers(
  state: MatchState,
  forfeitingIds: readonly PlayerId[],
  now: number,
  random: RandomSource = Math.random
): void {
  if (state.phase === "finished") return;
  const forfeits = new Set(forfeitingIds);
  const activeTurnWasInterrupted = forfeits.has(state.attackerId)
    || (state.defenderId !== null && forfeits.has(state.defenderId));
  for (const player of state.players) {
    if (!forfeits.has(player.id)) continue;
    player.eliminated = true;
    player.hp = 0;
  }
  recycleEliminatedCards(state, random);
  if (setLastPlayerOutcome(state, "forfeit")) return;
  if (activeTurnWasInterrupted) beginNextTurn(state, now);
}

export function countAllCards(state: MatchState): number {
  return state.deck.length + state.players.reduce((total, player) => total + player.hand.length, 0);
}

export function assertMatchInvariants(state: MatchState): void {
  const expectedCards = CARD_SYMBOLS.length * (state.players.length + 4);
  if (state.config.copiesPerSymbol !== state.players.length + 4 || countAllCards(state) !== expectedCards) {
    throw new RuleError(`Expected ${expectedCards} cards across deck and hands.`);
  }
  const ids = [...state.deck, ...state.players.flatMap((player) => player.hand)].map((card) => card.id);
  if (new Set(ids).size !== ids.length) throw new RuleError("A card instance exists in more than one place.");
  if (!state.players.some((player) => player.id === state.attackerId)) {
    throw new RuleError("The active attacker is not seated.");
  }
  if (["preparation", "battle", "discard"].includes(state.phase) && !state.defenderId) {
    throw new RuleError("An active duel requires a defender.");
  }
  for (const player of state.players) {
    if (!Number.isInteger(player.hp) || player.hp < 0) throw new RuleError("Player HP is invalid.");
    if (player.eliminated && player.hp !== 0) throw new RuleError("An eliminated player must have 0 HP.");
    if ((state.phase === "targeting" || state.phase === "preparation")
      && player.hand.length > state.config.maximumHandSize) {
      throw new RuleError("An actionable turn began with a hand above the maximum size.");
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
