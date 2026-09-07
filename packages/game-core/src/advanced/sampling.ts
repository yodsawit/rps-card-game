import type { CardSymbol, PlayerId, RandomSource } from "../types.js";
import type { PlayedHandMemory, DrawChangeMemory, SampledHand, HandSamplingView, JointHandSamplingView, JointSampledHands } from "./types.js";
import { emptyCounts, cloneCounts, countSymbols, subtractSymbols, containsSymbols, drawSymbols, countKey, addCounts, withinCounts } from "./common.js";

export function sourceHand(
  observation: PlayedHandMemory,
  publicPool: Record<CardSymbol, number>,
  random: RandomSource
): CardSymbol[] | null {
  const visible = observation.symbols.filter((symbol): symbol is CardSymbol => symbol !== null);
  if (visible.length > observation.handCount) return null;
  const pool = cloneCounts(publicPool);
  if (!subtractSymbols(pool, visible)) return null;
  const extras = drawSymbols(pool, observation.handCount - visible.length, random);
  return extras ? [...visible, ...extras] : null;
}

export function applyDrawChange(
  hand: readonly CardSymbol[],
  change: DrawChangeMemory | undefined,
  publicPool: Record<CardSymbol, number>,
  random: RandomSource
): CardSymbol[] | null {
  if (!change) return [...hand];
  const pool = cloneCounts(publicPool);
  if (!subtractSymbols(pool, hand)) return null;
  const drawn = drawSymbols(pool, change.drawnCount, random);
  if (!drawn) return null;
  const result = [...hand, ...drawn];
  for (let index = 0; index < change.discardedCount; index += 1) {
    if (result.length === 0) return null;
    result.splice(Math.floor(random() * result.length), 1);
  }
  return result;
}

export function sampleOneHand(view: HandSamplingView, random: RandomSource): CardSymbol[] | null {
  const publicPool = emptyCounts(view.copiesPerSymbol);
  if (!subtractSymbols(publicPool, view.observerHand.map((card) => card.symbol))) return null;
  const hands = [...view.memory.playedHands].sort((left, right) => left.round - right.round).slice(-2);
  const changes = new Map(view.memory.drawChanges.map((change) => [change.round, change]));
  let hand: CardSymbol[] | null;

  if (hands.length === 0) {
    hand = drawSymbols(cloneCounts(publicPool), view.opponentHandCount, random);
  } else if (hands.length === 1) {
    hand = sourceHand(hands[0]!, publicPool, random);
    if (hand) hand = applyDrawChange(hand, changes.get(hands[0]!.round), publicPool, random);
  } else {
    hand = sourceHand(hands[0]!, publicPool, random);
    if (hand) hand = applyDrawChange(hand, changes.get(hands[0]!.round), publicPool, random);
    const latestSymbols = hands[1]!.symbols.filter((symbol): symbol is CardSymbol => symbol !== null);
    if (!hand || hand.length !== hands[1]!.handCount || !containsSymbols(hand, latestSymbols)) return null;
    hand = applyDrawChange(hand, changes.get(hands[1]!.round), publicPool, random);
  }

  if (!hand || hand.length !== view.opponentHandCount) return null;
  const revealed = (view.currentRevealedSymbols ?? []).filter(
    (symbol): symbol is CardSymbol => symbol !== null
  );
  return containsSymbols(hand, revealed) ? hand : null;
}

export function fallbackHand(view: HandSamplingView, random: RandomSource): CardSymbol[] | null {
  const publicPool = emptyCounts(view.copiesPerSymbol);
  if (!subtractSymbols(publicPool, view.observerHand.map((card) => card.symbol))) return null;
  const revealed = (view.currentRevealedSymbols ?? []).filter(
    (symbol): symbol is CardSymbol => symbol !== null
  );
  if (revealed.length > view.opponentHandCount || !subtractSymbols(publicPool, revealed)) return null;
  const rest = drawSymbols(publicPool, view.opponentHandCount - revealed.length, random);
  return rest ? [...revealed, ...rest] : null;
}

export function sampleOpponentHands(
  view: HandSamplingView,
  random: RandomSource = Math.random,
  sampleCount = 512
): SampledHand[] {
  const requested = Math.max(1, Math.floor(sampleCount));
  const frequencies = new Map<string, { counts: Record<CardSymbol, number>; hits: number }>();
  let accepted = 0;
  for (let attempt = 0; attempt < requested * 30 && accepted < requested; attempt += 1) {
    const hand = sampleOneHand(view, random);
    if (!hand) continue;
    const counts = countSymbols(hand);
    const key = countKey(counts);
    const previous = frequencies.get(key);
    if (previous) previous.hits += 1;
    else frequencies.set(key, { counts, hits: 1 });
    accepted += 1;
  }
  const historyAccepted = accepted;
  while (accepted < requested) {
    const hand = fallbackHand(view, random);
    if (!hand) break;
    const counts = countSymbols(hand);
    const key = countKey(counts);
    const previous = frequencies.get(key);
    if (previous) previous.hits += 1;
    else frequencies.set(key, { counts, hits: 1 });
    accepted += 1;
  }
  if (accepted === 0) throw new Error("No opponent hand is compatible with public card information.");
  return [...frequencies.values()].map(({ counts, hits }) => ({
    counts,
    samples: hits,
    probability: hits / accepted,
    historyFallbackRate: (accepted - historyAccepted) / accepted
  }));
}

export function fallbackJointHands(
  view: JointHandSamplingView,
  random: RandomSource
): Map<PlayerId, CardSymbol[]> | null {
  const pool = emptyCounts(view.copiesPerSymbol);
  if (!subtractSymbols(pool, view.observerHand.map((card) => card.symbol))) return null;
  const result = new Map<PlayerId, CardSymbol[]>();
  for (const opponent of view.opponents) {
    const revealed = (opponent.currentRevealedSymbols ?? []).filter(
      (symbol): symbol is CardSymbol => symbol !== null
    );
    if (revealed.length > opponent.handCount || !subtractSymbols(pool, revealed)) return null;
    const rest = drawSymbols(pool, opponent.handCount - revealed.length, random);
    if (!rest) return null;
    result.set(opponent.id, [...revealed, ...rest]);
  }
  return result;
}

export function sampleAllOpponentHands(
  view: JointHandSamplingView,
  random: RandomSource = Math.random,
  sampleCount = 512
): JointSampledHands[] {
  const requested = Math.max(1, Math.floor(sampleCount));
  const publicPool = emptyCounts(view.copiesPerSymbol);
  if (!subtractSymbols(publicPool, view.observerHand.map((card) => card.symbol))) {
    throw new Error("Observer hand exceeds the public card supply.");
  }
  const frequencies = new Map<PlayerId, Map<string, { counts: Record<CardSymbol, number>; hits: number }>>();
  for (const opponent of view.opponents) frequencies.set(opponent.id, new Map());
  let accepted = 0;
  for (let attempt = 0; attempt < requested * 100 && accepted < requested; attempt += 1) {
    const hands = new Map<PlayerId, CardSymbol[]>();
    const combined = emptyCounts();
    let compatible = true;
    for (const opponent of view.opponents) {
      const hand = sampleOneHand({
        copiesPerSymbol: view.copiesPerSymbol,
        observerHand: view.observerHand,
        opponentHandCount: opponent.handCount,
        memory: opponent.memory,
        ...(opponent.currentRevealedSymbols
          ? { currentRevealedSymbols: opponent.currentRevealedSymbols }
          : {})
      }, random);
      if (!hand) {
        compatible = false;
        break;
      }
      hands.set(opponent.id, hand);
      addCounts(combined, countSymbols(hand));
      if (!withinCounts(combined, publicPool)) {
        compatible = false;
        break;
      }
    }
    if (!compatible) continue;
    for (const [id, hand] of hands) {
      const counts = countSymbols(hand);
      const key = countKey(counts);
      const map = frequencies.get(id)!;
      const previous = map.get(key);
      if (previous) previous.hits += 1;
      else map.set(key, { counts, hits: 1 });
    }
    accepted += 1;
  }
  const historyAccepted = accepted;
  while (accepted < requested) {
    const hands = fallbackJointHands(view, random);
    if (!hands) break;
    for (const [id, hand] of hands) {
      const counts = countSymbols(hand);
      const key = countKey(counts);
      const map = frequencies.get(id)!;
      const previous = map.get(key);
      if (previous) previous.hits += 1;
      else map.set(key, { counts, hits: 1 });
    }
    accepted += 1;
  }
  if (accepted === 0) throw new Error("No joint hidden-card state is compatible with public information.");
  return view.opponents.map((opponent) => ({
    id: opponent.id,
    hands: [...frequencies.get(opponent.id)!.values()].map(({ counts, hits }) => ({
      counts,
      samples: hits,
      probability: hits / accepted,
      historyFallbackRate: (accepted - historyAccepted) / accepted
    }))
  }));
}
