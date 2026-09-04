import { CARD_SYMBOLS, type Card, type GameConfig, type RandomSource } from "./types.js";

export function createDeck(config: GameConfig): Card[] {
  return CARD_SYMBOLS.flatMap((symbol) =>
    Array.from({ length: config.copiesPerSymbol }, (_, copyIndex) => ({
      id: `${symbol}-${copyIndex + 1}`,
      symbol
    }))
  );
}

export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

export function seededRandom(seed: number): RandomSource {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}
