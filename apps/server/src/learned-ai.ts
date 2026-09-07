import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CARD_SYMBOLS,
  POLICY_SCHEMA,
  type Card,
  type CardSymbol,
  type RandomSource
} from "@rps/game-core";
import type { Room } from "./types.js";

const MAX_TOTAL_HP = POLICY_SCHEMA.normalization.hp;

interface PolicyLayers {
  body0Weight: number[][];
  body0Bias: number[];
  body2Weight: number[][];
  body2Bias: number[];
  policyWeight: number[][];
  policyBias: number[];
}

interface PolicyWeights {
  schemaVersion: number;
  observationSize: number;
  hiddenSize: number;
  actionSize: number;
  layers: PolicyLayers;
}

export interface LearnedPairChoice {
  cardId: string;
  hearts: number;
  actionProbability: number;
  valueEstimate: number | null;
}

const weightsPath = fileURLToPath(new URL("../models/rps_policy.weights.json", import.meta.url));
const weights = JSON.parse(readFileSync(weightsPath, "utf8")) as PolicyWeights;
const ACTION_SIZE = weights.actionSize;
const HEART_LEVELS = ACTION_SIZE / 3;

if (weights.observationSize !== POLICY_SCHEMA.observationSize
  || POLICY_SCHEMA.actionSchemas[weights.schemaVersion as 1 | 2] !== ACTION_SIZE) {
  throw new Error("The deployed learned-policy weights do not match a supported observation/action schema.");
}

function dense(input: readonly number[], matrix: readonly number[][], bias: readonly number[]): number[] {
  return matrix.map((row, output) => {
    let result = bias[output]!;
    for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
      result += row[inputIndex]! * input[inputIndex]!;
    }
    return result;
  });
}

export function inferLearnedPolicy(observation: readonly number[]): number[] {
  if (observation.length !== weights.observationSize) {
    throw new Error(`Learned policy expected ${weights.observationSize} observations.`);
  }
  const first = dense(observation, weights.layers.body0Weight, weights.layers.body0Bias).map(Math.tanh);
  const second = dense(first, weights.layers.body2Weight, weights.layers.body2Bias).map(Math.tanh);
  return dense(second, weights.layers.policyWeight, weights.layers.policyBias);
}

function selectAction(
  observation: readonly number[],
  legalMask: readonly boolean[],
  random: RandomSource
): { action: number; probability: number } {
  const logits = inferLearnedPolicy(observation);
  const legal = logits
    .map((logit, action) => ({ action, logit }))
    .filter(({ action }) => legalMask[action]);
  if (legal.length === 0) throw new Error("The learned policy has no legal action.");
  const maximum = Math.max(...legal.map(({ logit }) => logit));
  const probabilities = legal.map(({ logit }) => Math.exp(logit - maximum));
  const total = probabilities.reduce((sum, probability) => sum + probability, 0);
  let roll = random() * total;
  for (let index = 0; index < legal.length; index += 1) {
    roll -= probabilities[index]!;
    if (roll <= 0 || index === legal.length - 1) {
      return { action: legal[index]!.action, probability: probabilities[index]! / total };
    }
  }
  throw new Error("The learned-policy sampler did not select an action.");
}

function symbolIndex(symbol: CardSymbol): number {
  return CARD_SYMBOLS.indexOf(symbol);
}

function symbolOneHot(symbol: CardSymbol | null): number[] {
  const values = [0, 0, 0, 0];
  values[symbol === null ? 0 : symbolIndex(symbol) + 1] = 1;
  return values;
}

function encodeObservation(
  room: Room,
  playerId: string,
  phase: "battle" | "buy" | "discard",
  ownHandOverride?: readonly Card[]
): number[] {
  const game = room.game!;
  const player = game.players.find((candidate) => candidate.id === playerId)!;
  const opponentId = player.id === game.attackerId ? game.defenderId : game.attackerId;
  const opponent = game.players.find((candidate) => candidate.id === opponentId)!;
  const ownHand = ownHandOverride ?? player.hand;
  const phaseIndex = phase === "battle" ? game.preparationLane : phase === "buy" ? 3 : 4;
  const observation = Array.from({ length: 5 }, (_, index) => Number(index === phaseIndex));
  observation.push(player.hp / MAX_TOTAL_HP, opponent.hp / MAX_TOTAL_HP);
  for (const symbol of CARD_SYMBOLS) {
    observation.push(ownHand.filter((card) => card.symbol === symbol).length / 8);
  }
  observation.push(
    opponent.hand.length / 8,
    game.deck.length / (CARD_SYMBOLS.length * game.config.copiesPerSymbol),
    Number(player.id === game.attackerId),
    Number(phase === "battle" && player.id === game.attackerId),
    Number(phase === "battle" && opponent.slots[game.preparationLane]!.cardId !== null),
    phase === "battle" ? opponent.slots[game.preparationLane]!.hearts / MAX_TOTAL_HP : 0,
    (player.hp - player.slots.reduce((sum, slot) => sum + slot.hearts, 0)) / MAX_TOTAL_HP,
    (opponent.hp - opponent.slots.reduce((sum, slot) => sum + slot.hearts, 0)) / MAX_TOTAL_HP
  );

  const cardSymbol = (owner: typeof player, lane: number): CardSymbol | null => {
    const cardId = owner.slots[lane]!.cardId;
    return cardId === null ? null : owner.hand.find((card) => card.id === cardId)?.symbol ?? null;
  };
  for (let lane = 0; lane < 3; lane += 1) {
    const ownSymbol = cardSymbol(player, lane);
    const opponentSymbol = phase === "battle" && lane < game.preparationLane
      ? cardSymbol(opponent, lane)
      : null;
    observation.push(...symbolOneHot(ownSymbol), player.slots[lane]!.hearts / MAX_TOTAL_HP);
    observation.push(...symbolOneHot(opponentSymbol), opponent.slots[lane]!.hearts / MAX_TOTAL_HP);
  }

  const memory = room.knownHands.get(opponent.id);
  const playedHands = memory?.playedHands.slice(-2) ?? [];
  const padded = [...Array.from({ length: 2 - playedHands.length }, () => null), ...playedHands];
  for (const hand of padded) {
    if (hand === null) {
      observation.push(...Array.from({ length: 21 }, () => 0));
      continue;
    }
    const change = memory?.drawChanges.find((candidate) => candidate.round === hand.round);
    const currentUnresolvedDraw = !change && hand.round === game.round && game.phase === "discard";
    observation.push(1, hand.handCount / 8);
    for (const symbol of hand.symbols) observation.push(...symbolOneHot(symbol));
    observation.push(...hand.hearts.map((hearts) => hearts / MAX_TOTAL_HP));
    observation.push(
      (change?.drawnCount ?? 0) / 3,
      (change?.discardedCount ?? 0) / 3,
      Number(change?.bonusDraw ?? (currentUnresolvedDraw && opponent.noLossBonus)),
      Number(change?.paidDraw ?? false)
    );
  }
  if (observation.length !== weights.observationSize) {
    throw new Error(`Learned policy produced ${observation.length} observations instead of 90.`);
  }
  return observation;
}

function battleMask(room: Room, playerId: string): boolean[] {
  const game = room.game!;
  const player = game.players.find((candidate) => candidate.id === playerId)!;
  const committed = new Set(player.slots.map((slot) => slot.cardId).filter((id): id is string => id !== null));
  const remainingHp = player.hp - player.slots.reduce((sum, slot) => sum + slot.hearts, 0);
  const mask = Array.from({ length: ACTION_SIZE }, () => false);
  for (const symbol of CARD_SYMBOLS) {
    if (!player.hand.some((card) => card.symbol === symbol && !committed.has(card.id))) continue;
    const heartValues = game.preparationLane === 2
      ? [Math.min(remainingHp, HEART_LEVELS - 1)]
      : Array.from({ length: Math.min(remainingHp, HEART_LEVELS - 1) + 1 }, (_, hearts) => hearts);
    for (const hearts of heartValues) mask[symbolIndex(symbol) * HEART_LEVELS + hearts] = true;
  }
  return mask;
}

export interface LearnedDecisionInput {
  kind: "pair" | "buy" | "discard";
  observation: number[];
  hand: Card[];
  mask: boolean[];
  remainingHp: number;
  finalLane: boolean;
  requiredDiscards: number;
}

/** Build the complete policy input before crossing the worker boundary. */
export function makeLearnedInput(room: Room, playerId: string,
  kind: LearnedDecisionInput["kind"], requiredDiscards = 0): LearnedDecisionInput {
  const game = room.game!;
  const player = game.players.find((candidate) => candidate.id === playerId)!;
  const committed = new Set(player.slots.map((slot) => slot.cardId));
  const mask = kind === "pair" ? battleMask(room, playerId) : Array.from({ length: ACTION_SIZE }, () => false);
  if (kind === "buy") { mask[0] = true; mask[1] = player.hp > 1 && game.deck.length > 0; }
  return { kind, observation: encodeObservation(room, playerId, kind === "pair" ? "battle" : kind),
    hand: player.hand.filter((card) => kind !== "pair" || !committed.has(card.id)).map((card) => ({ ...card })),
    mask, remainingHp: player.hp - player.slots.reduce((sum, slot) => sum + slot.hearts, 0),
    finalLane: game.preparationLane === 2, requiredDiscards };
}

export function decideLearned(input: LearnedDecisionInput, random: RandomSource): LearnedPairChoice | boolean | string[] {
  if (input.kind === "buy") return selectAction(input.observation, input.mask, random).action === 1;
  if (input.kind === "pair") {
    const selected = selectAction(input.observation, input.mask, random);
    const symbol = CARD_SYMBOLS[Math.floor(selected.action / HEART_LEVELS)]!;
    const card = input.hand.find((candidate) => candidate.symbol === symbol);
    if (!card) throw new Error("The learned policy selected an unavailable card symbol.");
    return { cardId: card.id, hearts: input.finalLane ? input.remainingHp : selected.action % HEART_LEVELS,
      actionProbability: selected.probability, valueEstimate: null };
  }
  const remaining = [...input.hand];
  const selectedIds: string[] = [];
  for (let index = 0; index < input.requiredDiscards; index += 1) {
    const mask = Array.from({ length: ACTION_SIZE }, () => false);
    for (const card of remaining) mask[symbolIndex(card.symbol)] = true;
    const observation = [...input.observation];
    CARD_SYMBOLS.forEach((symbol, index) => { observation[7 + index] = remaining.filter((card) => card.symbol === symbol).length / 8; });
    const selected = selectAction(observation, mask, random);
    const cardIndex = remaining.findIndex((card) => card.symbol === CARD_SYMBOLS[selected.action]);
    if (cardIndex < 0) throw new Error("The learned policy selected an unavailable discard symbol.");
    selectedIds.push(remaining[cardIndex]!.id);
    remaining.splice(cardIndex, 1);
  }
  return selectedIds;
}

export function chooseLearnedPair(room: Room, playerId: string, random: RandomSource): LearnedPairChoice {
  return decideLearned(makeLearnedInput(room, playerId, "pair"), random) as LearnedPairChoice;
}
export function shouldLearnedPurchaseExtraDraw(room: Room, playerId: string, random: RandomSource): boolean {
  return decideLearned(makeLearnedInput(room, playerId, "buy"), random) as boolean;
}
export function chooseLearnedDiscards(room: Room, playerId: string, requiredDiscards: number, random: RandomSource): string[] {
  return decideLearned(makeLearnedInput(room, playerId, "discard", requiredDiscards), random) as string[];
}
