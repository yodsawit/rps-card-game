import type { CardSymbol } from "../types.js";
import { receivedHp } from "../combat.js";
import { CRITICAL_HP_RATIO, CRITICAL_HP_PRESERVATION_WEIGHT, compareSymbols, isTriple } from "./common.js";

export function duelUtility(
  ownSymbols: readonly (CardSymbol | null)[],
  ownHearts: readonly number[],
  opposingSymbols: readonly (CardSymbol | null)[],
  opposingHearts: readonly number[]
): number {
  const ownTriple = isTriple(ownSymbols);
  const opposingTriple = isTriple(opposingSymbols);
  let ownFinal = 0;
  let opposingFinal = 0;
  for (let lane = 0; lane < 3; lane += 1) {
    const ownSymbol = ownSymbols[lane] ?? null;
    const opposingSymbol = opposingSymbols[lane] ?? null;
    let result: -1 | 0 | 1;
    if (!ownSymbol && !opposingSymbol) result = 0;
    else if (!ownSymbol) result = -1;
    else if (!opposingSymbol) result = 1;
    else {
      result = compareSymbols(ownSymbol, opposingSymbol);
      if (result === 0 && ownTriple !== opposingTriple) result = ownTriple ? 1 : -1;
    }
    const ownStake = ownHearts[lane] ?? 0;
    const opposingStake = opposingHearts[lane] ?? 0;
    ownFinal += receivedHp(result === 0 ? "draw" : result > 0 ? "win" : "loss", ownStake, opposingStake);
    opposingFinal += receivedHp(result === 0 ? "draw" : result < 0 ? "win" : "loss", opposingStake, ownStake);
  }
  const ownStartingHp = ownHearts.reduce((sum, hearts) => sum + hearts, 0);
  const opposingStartingHp = opposingHearts.reduce((sum, hearts) => sum + hearts, 0);
  const preservationWeight = ownStartingHp <= opposingStartingHp * CRITICAL_HP_RATIO
    ? CRITICAL_HP_PRESERVATION_WEIGHT
    : 1;
  return preservationWeight * ownFinal - opposingFinal;
}
