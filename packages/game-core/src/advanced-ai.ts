import type { BattleSlot, Card, CardSymbol, PlayerId, PreparationLane, RandomSource } from "./types.js";

export interface PlayedHandMemory {
  round: number;
  handCount: number;
  symbols: readonly [CardSymbol | null, CardSymbol | null, CardSymbol | null];
  hearts: readonly [number, number, number];
}

export interface DrawChangeMemory {
  round: number;
  drawnCount: number;
  discardedCount: number;
  handDelta: number;
  bonusDraw: boolean;
  paidDraw: boolean;
}

export interface AdvancedPublicMemory {
  playedHands: readonly PlayedHandMemory[];
  drawChanges: readonly DrawChangeMemory[];
}

export interface SampledHand {
  counts: Record<CardSymbol, number>;
  samples: number;
  probability: number;
}

export interface HandSamplingView {
  copiesPerSymbol: number;
  observerHand: readonly Card[];
  opponentHandCount: number;
  memory: AdvancedPublicMemory;
  currentRevealedSymbols?: readonly (CardSymbol | null)[];
}

export interface PublicOpponentSamplingView {
  id: PlayerId;
  handCount: number;
  memory: AdvancedPublicMemory;
  currentRevealedSymbols?: readonly (CardSymbol | null)[];
}

export interface JointHandSamplingView {
  copiesPerSymbol: number;
  observerHand: readonly Card[];
  opponents: readonly PublicOpponentSamplingView[];
}

export interface JointSampledHands {
  id: PlayerId;
  hands: SampledHand[];
}

export interface AdvancedTargetView {
  playerId: PlayerId;
  hand: readonly Card[];
  copiesPerSymbol: number;
  opponents: ReadonlyArray<{
    id: PlayerId;
    eliminated: boolean;
    handCount: number;
    memory: AdvancedPublicMemory;
  }>;
  sampleCount?: number;
}

export interface AdvancedShuffleOpponent extends PublicOpponentSamplingView {
  eliminated: boolean;
  hp: number;
}

export interface AdvancedShuffleView {
  playerId: PlayerId;
  hand: readonly Card[];
  hp: number;
  requiredDiscards: number;
  deckCount: number;
  copiesPerSymbol: number;
  opponents: readonly AdvancedShuffleOpponent[];
  sampleCount?: number;
}

export interface AdvancedDrawAnalysis {
  purchase: boolean;
  skipValue: number;
  purchaseValue: number | null;
  drawProbabilities: Record<CardSymbol, number>;
  sampleCount: number;
}

export interface AdvancedPairView extends HandSamplingView {
  playerId: PlayerId;
  hand: readonly Card[];
  hp: number;
  activeLane: PreparationLane;
  ownSlots: readonly BattleSlot[];
  opponentHp: number;
  opponentId?: PlayerId;
  opponentLocked?: boolean;
  tableOpponents?: readonly PublicOpponentSamplingView[];
  opponentPositions: ReadonlyArray<{ occupied: boolean; hearts: number }>;
  sampleCount?: number;
}

export interface AdvancedPairChoice {
  cardId: string;
  hearts: number;
  equilibriumValue: number;
  analysis: AdvancedPairAnalysis;
}

export interface AdvancedCurrentActionProbability {
  symbol: CardSymbol;
  hearts: number;
  probability: number;
}

export interface AdvancedPairAnalysis {
  sampledHands: SampledHand[];
  sampleCount: number;
  nextCardProbabilities: Record<CardSymbol, number>;
  ownPlanCount: number;
  opponentSequenceCount: number;
  opponentPlanCount: number;
  equilibriumIterations: number;
  currentActions: AdvancedCurrentActionProbability[];
}

interface BayesianType<TAction> {
  probability: number;
  actions: readonly TAction[];
}

interface EquilibriumResult {
  probabilities: number[];
  value: number;
}

const EPSILON = 1e-9;
const LP_INFINITY = 1e100;
const CRITICAL_HP_RATIO = 0.5;
const CRITICAL_HP_PRESERVATION_WEIGHT = 1.5;

function emptyCounts(copies = 0): Record<CardSymbol, number> {
  return { rock: copies, paper: copies, scissors: copies };
}

function cloneCounts(counts: Record<CardSymbol, number>): Record<CardSymbol, number> {
  return { rock: counts.rock, paper: counts.paper, scissors: counts.scissors };
}

function countSymbols(symbols: readonly CardSymbol[]): Record<CardSymbol, number> {
  const result = emptyCounts();
  for (const symbol of symbols) result[symbol] += 1;
  return result;
}

function totalCounts(counts: Record<CardSymbol, number>): number {
  return counts.rock + counts.paper + counts.scissors;
}

function subtractSymbols(
  counts: Record<CardSymbol, number>,
  symbols: readonly CardSymbol[]
): boolean {
  for (const symbol of symbols) {
    counts[symbol] -= 1;
    if (counts[symbol] < 0) return false;
  }
  return true;
}

function containsSymbols(hand: readonly CardSymbol[], required: readonly CardSymbol[]): boolean {
  const available = countSymbols(hand);
  const needed = countSymbols(required);
  return needed.rock <= available.rock
    && needed.paper <= available.paper
    && needed.scissors <= available.scissors;
}

function drawSymbol(counts: Record<CardSymbol, number>, random: RandomSource): CardSymbol | null {
  const total = totalCounts(counts);
  if (total <= 0) return null;
  let roll = random() * total;
  for (const symbol of ["rock", "paper", "scissors"] as const) {
    roll -= counts[symbol];
    if (roll < 0) {
      counts[symbol] -= 1;
      return symbol;
    }
  }
  return "scissors";
}

function drawSymbols(
  counts: Record<CardSymbol, number>,
  amount: number,
  random: RandomSource
): CardSymbol[] | null {
  const drawn: CardSymbol[] = [];
  for (let index = 0; index < amount; index += 1) {
    const symbol = drawSymbol(counts, random);
    if (!symbol) return null;
    drawn.push(symbol);
  }
  return drawn;
}

function sourceHand(
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

function applyDrawChange(
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

function sampleOneHand(view: HandSamplingView, random: RandomSource): CardSymbol[] | null {
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

function fallbackHand(view: HandSamplingView, random: RandomSource): CardSymbol[] | null {
  const publicPool = emptyCounts(view.copiesPerSymbol);
  if (!subtractSymbols(publicPool, view.observerHand.map((card) => card.symbol))) return null;
  const revealed = (view.currentRevealedSymbols ?? []).filter(
    (symbol): symbol is CardSymbol => symbol !== null
  );
  if (revealed.length > view.opponentHandCount || !subtractSymbols(publicPool, revealed)) return null;
  const rest = drawSymbols(publicPool, view.opponentHandCount - revealed.length, random);
  return rest ? [...revealed, ...rest] : null;
}

function countKey(counts: Record<CardSymbol, number>): string {
  return `${counts.rock},${counts.paper},${counts.scissors}`;
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
    probability: hits / accepted
  }));
}

function addCounts(target: Record<CardSymbol, number>, source: Record<CardSymbol, number>): void {
  target.rock += source.rock;
  target.paper += source.paper;
  target.scissors += source.scissors;
}

function withinCounts(value: Record<CardSymbol, number>, maximum: Record<CardSymbol, number>): boolean {
  return value.rock <= maximum.rock
    && value.paper <= maximum.paper
    && value.scissors <= maximum.scissors;
}

function fallbackJointHands(
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
      probability: hits / accepted
    }))
  }));
}

class LinearProgram {
  private readonly rowCount: number;
  private readonly variableCount: number;
  private readonly basic: number[];
  private readonly nonBasic: number[];
  private readonly tableau: number[][];

  constructor(matrix: readonly number[][], bounds: readonly number[], objective: readonly number[]) {
    this.rowCount = bounds.length;
    this.variableCount = objective.length;
    this.basic = Array.from({ length: this.rowCount }, (_, index) => this.variableCount + index);
    this.nonBasic = Array.from({ length: this.variableCount + 1 }, (_, index) => index);
    this.nonBasic[this.variableCount] = -1;
    this.tableau = Array.from(
      { length: this.rowCount + 2 },
      () => Array.from({ length: this.variableCount + 2 }, () => 0)
    );
    for (let row = 0; row < this.rowCount; row += 1) {
      for (let column = 0; column < this.variableCount; column += 1) {
        this.tableau[row]![column] = matrix[row]?.[column] ?? 0;
      }
      this.tableau[row]![this.variableCount] = -1;
      this.tableau[row]![this.variableCount + 1] = bounds[row]!;
    }
    for (let column = 0; column < this.variableCount; column += 1) {
      this.tableau[this.rowCount]![column] = -objective[column]!;
    }
    this.tableau[this.rowCount + 1]![this.variableCount] = 1;
  }

  private pivot(row: number, column: number): void {
    const inverse = 1 / this.tableau[row]![column]!;
    for (let otherRow = 0; otherRow < this.rowCount + 2; otherRow += 1) {
      if (otherRow === row) continue;
      const targetRow = this.tableau[otherRow]!;
      const pivotRow = this.tableau[row]!;
      for (let otherColumn = 0; otherColumn < this.variableCount + 2; otherColumn += 1) {
        if (otherColumn === column) continue;
        targetRow[otherColumn] = targetRow[otherColumn]! - pivotRow[otherColumn]!
          * targetRow[column]! * inverse;
      }
    }
    const pivotRow = this.tableau[row]!;
    for (let otherColumn = 0; otherColumn < this.variableCount + 2; otherColumn += 1) {
      if (otherColumn !== column) pivotRow[otherColumn] = pivotRow[otherColumn]! * inverse;
    }
    for (let otherRow = 0; otherRow < this.rowCount + 2; otherRow += 1) {
      const targetRow = this.tableau[otherRow]!;
      if (otherRow !== row) targetRow[column] = targetRow[column]! * -inverse;
    }
    pivotRow[column] = inverse;
    [this.basic[row], this.nonBasic[column]] = [this.nonBasic[column]!, this.basic[row]!];
  }

  private simplex(phase: 1 | 2): boolean {
    const objectiveRow = phase === 1 ? this.rowCount + 1 : this.rowCount;
    while (true) {
      let entering = -1;
      for (let column = 0; column <= this.variableCount; column += 1) {
        if (phase === 2 && this.nonBasic[column] === -1) continue;
        if (
          entering === -1
          || this.tableau[objectiveRow]![column]! < this.tableau[objectiveRow]![entering]! - EPSILON
          || (Math.abs(this.tableau[objectiveRow]![column]! - this.tableau[objectiveRow]![entering]!) <= EPSILON
            && this.nonBasic[column]! < this.nonBasic[entering]!)
        ) entering = column;
      }
      if (entering === -1 || this.tableau[objectiveRow]![entering]! >= -EPSILON) return true;
      let leaving = -1;
      for (let row = 0; row < this.rowCount; row += 1) {
        if (this.tableau[row]![entering]! <= EPSILON) continue;
        if (
          leaving === -1
          || this.tableau[row]![this.variableCount + 1]! / this.tableau[row]![entering]!
            < this.tableau[leaving]![this.variableCount + 1]! / this.tableau[leaving]![entering]! - EPSILON
          || (Math.abs(
            this.tableau[row]![this.variableCount + 1]! / this.tableau[row]![entering]!
              - this.tableau[leaving]![this.variableCount + 1]! / this.tableau[leaving]![entering]!
          ) <= EPSILON && this.basic[row]! < this.basic[leaving]!)
        ) leaving = row;
      }
      if (leaving === -1) return false;
      this.pivot(leaving, entering);
    }
  }

  solve(solution: number[]): number {
    let row = 0;
    for (let candidate = 1; candidate < this.rowCount; candidate += 1) {
      if (this.tableau[candidate]![this.variableCount + 1]! < this.tableau[row]![this.variableCount + 1]!) {
        row = candidate;
      }
    }
    if (this.tableau[row]![this.variableCount + 1]! < -EPSILON) {
      this.pivot(row, this.variableCount);
      if (!this.simplex(1) || this.tableau[this.rowCount + 1]![this.variableCount + 1]! < -EPSILON) {
        return -LP_INFINITY;
      }
      if (Math.abs(this.tableau[this.rowCount + 1]![this.variableCount + 1]!) > EPSILON) {
        return -LP_INFINITY;
      }
      const artificialRow = this.basic.indexOf(-1);
      if (artificialRow >= 0) {
        let entering = 0;
        for (let column = 1; column <= this.variableCount; column += 1) {
          if (
            this.tableau[artificialRow]![column]! < this.tableau[artificialRow]![entering]! - EPSILON
            || (Math.abs(this.tableau[artificialRow]![column]! - this.tableau[artificialRow]![entering]!) <= EPSILON
              && this.nonBasic[column]! < this.nonBasic[entering]!)
          ) entering = column;
        }
        this.pivot(artificialRow, entering);
      }
    }
    if (!this.simplex(2)) return LP_INFINITY;
    solution.splice(0, solution.length, ...Array.from({ length: this.variableCount }, () => 0));
    for (let basicRow = 0; basicRow < this.rowCount; basicRow += 1) {
      if (this.basic[basicRow]! < this.variableCount) {
        solution[this.basic[basicRow]!] = this.tableau[basicRow]![this.variableCount + 1]!;
      }
    }
    return this.tableau[this.rowCount]![this.variableCount + 1]!;
  }
}

export function solveBayesianMaximin<TRow, TColumn>(
  rows: readonly TRow[],
  types: readonly BayesianType<TColumn>[],
  payoff: (row: TRow, column: TColumn) => number
): EquilibriumResult {
  if (rows.length === 0 || types.length === 0 || types.some((type) => type.actions.length === 0)) {
    throw new Error("An equilibrium requires actions for both sides.");
  }
  let largestMagnitude = 0;
  for (const row of rows) {
    for (const type of types) {
      for (const column of type.actions) largestMagnitude = Math.max(largestMagnitude, Math.abs(payoff(row, column)));
    }
  }
  const shift = largestMagnitude + 1;
  const variableCount = rows.length + types.length;
  const matrix: number[][] = [];
  const bounds: number[] = [];
  for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
    for (const column of types[typeIndex]!.actions) {
      const constraint = Array.from({ length: variableCount }, () => 0);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        constraint[rowIndex] = -(payoff(rows[rowIndex]!, column) + shift);
      }
      constraint[rows.length + typeIndex] = 1;
      matrix.push(constraint);
      bounds.push(0);
    }
  }
  const upper = Array.from({ length: variableCount }, (_, index) => index < rows.length ? 1 : 0);
  const lower = upper.map((value) => -value);
  matrix.push(upper, lower);
  bounds.push(1, -1);
  const objective = Array.from({ length: variableCount }, (_, index) =>
    index < rows.length ? 0 : types[index - rows.length]!.probability
  );
  const solution: number[] = [];
  const shiftedValue = new LinearProgram(matrix, bounds, objective).solve(solution);
  if (!Number.isFinite(shiftedValue) || Math.abs(shiftedValue) >= LP_INFINITY / 2) {
    throw new Error("The equilibrium linear program could not be solved.");
  }
  const raw = solution.slice(0, rows.length).map((value) => Math.max(value, 0));
  const total = raw.reduce((sum, value) => sum + value, 0);
  const probabilities = total > EPSILON
    ? raw.map((value) => value / total)
    : rows.map(() => 1 / rows.length);
  return { probabilities, value: shiftedValue - shift };
}

function compareSymbols(left: CardSymbol, right: CardSymbol): -1 | 0 | 1 {
  if (left === right) return 0;
  return (left === "rock" && right === "scissors")
    || (left === "scissors" && right === "paper")
    || (left === "paper" && right === "rock")
    ? 1
    : -1;
}

function availableSymbols(
  counts: Record<CardSymbol, number>,
  committed: readonly (CardSymbol | null)[]
): CardSymbol[] {
  const remaining = cloneCounts(counts);
  subtractSymbols(remaining, committed.filter((symbol): symbol is CardSymbol => symbol !== null));
  return (["rock", "paper", "scissors"] as const).filter((symbol) => remaining[symbol] > 0);
}

function chooseByProbability<T>(items: readonly T[], probabilities: readonly number[], random: RandomSource): T {
  let roll = random();
  for (let index = 0; index < items.length; index += 1) {
    roll -= probabilities[index] ?? 0;
    if (roll <= EPSILON) return items[index]!;
  }
  return items[items.length - 1]!;
}

export function chooseAdvancedTarget(
  view: AdvancedTargetView,
  random: RandomSource = Math.random
): PlayerId {
  const ownSymbols = [...new Set(view.hand.map((card) => card.symbol))];
  if (ownSymbols.length === 0) throw new Error("Advanced computer has no card available.");
  const candidates = view.opponents.filter((opponent) => !opponent.eliminated && opponent.id !== view.playerId);
  if (candidates.length === 0) throw new Error("Advanced computer has no living opponent to attack.");
  const jointDistributions = sampleAllOpponentHands({
    copiesPerSymbol: view.copiesPerSymbol,
    observerHand: view.hand,
    opponents: candidates
  }, random, view.sampleCount ?? 512);
  const valued = candidates.map((opponent) => {
    const distribution = jointDistributions.find((candidate) => candidate.id === opponent.id)!.hands;
    const types = distribution.map((sample) => ({
      probability: sample.probability,
      actions: availableSymbols(sample.counts, [])
    }));
    const equilibrium = solveBayesianMaximin(
      ownSymbols,
      types,
      (own, opposing) => compareSymbols(own, opposing)
    );
    return { opponent, value: equilibrium.value };
  });
  const bestValue = Math.max(...valued.map((candidate) => candidate.value));
  const best = valued.filter((candidate) => Math.abs(candidate.value - bestValue) <= 1e-7);
  return best[Math.floor(random() * best.length)]!.opponent.id;
}

interface PairPlan {
  symbols: readonly (CardSymbol | null)[];
  hearts: readonly number[];
}

type CurrentStakeConstraint =
  | { kind: "minimum"; hearts: number }
  | { kind: "exact"; hearts: number };

interface FullPlanEquilibrium extends EquilibriumResult {
  iterations: number;
}

function orderedSymbolSequences(
  counts: Record<CardSymbol, number>,
  length: number
): CardSymbol[][] {
  const sequences: CardSymbol[][] = [];
  const selected: CardSymbol[] = [];
  const visit = (): void => {
    if (selected.length === length) {
      sequences.push([...selected]);
      return;
    }
    for (const symbol of ["rock", "paper", "scissors"] as const) {
      if (counts[symbol] <= 0) continue;
      counts[symbol] -= 1;
      selected.push(symbol);
      visit();
      selected.pop();
      counts[symbol] += 1;
    }
  };
  visit();
  return sequences;
}

function heartDistributions(total: number, length: number, minimumFirst: number): number[][] {
  if (length === 0) return total === 0 ? [[]] : [];
  if (length === 1) return total >= minimumFirst ? [[total]] : [];
  const distributions: number[][] = [];
  for (let first = minimumFirst; first <= total; first += 1) {
    for (const rest of heartDistributions(total - first, length - 1, 0)) {
      distributions.push([first, ...rest]);
    }
  }
  return distributions;
}

function constrainedHeartDistributions(
  total: number,
  length: number,
  constraint: CurrentStakeConstraint
): number[][] {
  if (constraint.kind === "minimum") {
    return heartDistributions(total, length, constraint.hearts);
  }
  if (length <= 0 || constraint.hearts < 0 || constraint.hearts > total) return [];
  return heartDistributions(total - constraint.hearts, length - 1, 0)
    .map((rest) => [constraint.hearts, ...rest]);
}

function pairPlans(
  handCounts: Record<CardSymbol, number>,
  priorSymbols: readonly (CardSymbol | null)[],
  priorHearts: readonly number[],
  hp: number,
  currentStake: CurrentStakeConstraint
): PairPlan[] {
  const remainingCounts = cloneCounts(handCounts);
  if (!subtractSymbols(
    remainingCounts,
    priorSymbols.filter((symbol): symbol is CardSymbol => symbol !== null)
  )) return [];
  const remainingLanes = 3 - priorSymbols.length;
  const remainingHp = hp - priorHearts.reduce((sum, hearts) => sum + hearts, 0);
  if (remainingLanes <= 0 || remainingHp < currentStake.hearts) return [];
  const sequences = orderedSymbolSequences(remainingCounts, remainingLanes);
  const distributions = constrainedHeartDistributions(remainingHp, remainingLanes, currentStake);
  return sequences.flatMap((sequence) => distributions.map((hearts) => ({
    symbols: [...priorSymbols, ...sequence],
    hearts: [...priorHearts, ...hearts]
  })));
}

function solveFullPlanMaximin(
  rows: readonly PairPlan[],
  types: readonly BayesianType<PairPlan>[]
): FullPlanEquilibrium {
  const restricted = types.map((type) => [type.actions[0]!]);
  const restrictedSets = restricted.map((actions) => new Set(actions));
  const maximumIterations = types.reduce((sum, type) => sum + type.actions.length, 0) + 1;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const equilibrium = solveBayesianMaximin(
      rows,
      types.map((type, index) => ({ probability: type.probability, actions: restricted[index]! })),
      (own, opposing) => duelUtility(own.symbols, own.hearts, opposing.symbols, opposing.hearts)
    );
    const support = equilibrium.probabilities
      .map((probability, index) => ({ probability, plan: rows[index]! }))
      .filter(({ probability }) => probability > EPSILON);
    let lowerBound = 0;
    const missingWorstResponses: Array<{ typeIndex: number; plan: PairPlan }> = [];
    for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
      const type = types[typeIndex]!;
      let worstPlan = type.actions[0]!;
      let worstValue = Number.POSITIVE_INFINITY;
      for (const opposing of type.actions) {
        const value = support.reduce((sum, own) => sum + own.probability
          * duelUtility(own.plan.symbols, own.plan.hearts, opposing.symbols, opposing.hearts), 0);
        if (value < worstValue - EPSILON) {
          worstValue = value;
          worstPlan = opposing;
        }
      }
      lowerBound += type.probability * worstValue;
      if (!restrictedSets[typeIndex]!.has(worstPlan)) {
        missingWorstResponses.push({ typeIndex, plan: worstPlan });
      }
    }
    if (equilibrium.value - lowerBound <= 1e-7) {
      return { ...equilibrium, iterations: iteration };
    }
    if (missingWorstResponses.length === 0) {
      if (equilibrium.value - lowerBound <= 1e-6) {
        return { ...equilibrium, iterations: iteration };
      }
      throw new Error("The full-plan equilibrium stopped before reaching its lower bound.");
    }
    for (const response of missingWorstResponses) {
      restricted[response.typeIndex]!.push(response.plan);
      restrictedSets[response.typeIndex]!.add(response.plan);
    }
  }
  throw new Error("The full-plan equilibrium did not converge.");
}

function isTriple(symbols: readonly (CardSymbol | null)[]): boolean {
  return symbols.length === 3 && symbols[0] !== null && symbols.every((symbol) => symbol === symbols[0]);
}

function duelUtility(
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
    if (result >= 0) ownFinal += result === 0 ? ownStake : ownStake + Math.max(opposingStake - 1, 0);
    if (result <= 0) opposingFinal += result === 0 ? opposingStake : opposingStake + Math.max(ownStake - 1, 0);
  }
  const ownStartingHp = ownHearts.reduce((sum, hearts) => sum + hearts, 0);
  const opposingStartingHp = opposingHearts.reduce((sum, hearts) => sum + hearts, 0);
  const preservationWeight = ownStartingHp <= opposingStartingHp * CRITICAL_HP_RATIO
    ? CRITICAL_HP_PRESERVATION_WEIGHT
    : 1;
  return preservationWeight * ownFinal - opposingFinal;
}

interface AdvancedRetentionModel {
  opponentTypes: BayesianType<readonly CardSymbol[]>[];
  drawProbabilities: Record<CardSymbol, number>;
  sampleCount: number;
  showdownValue: number;
  handValues: Map<string, number>;
}

interface AdvancedRetentionChoice {
  discarded: Card[];
  value: number;
}

function sequenceUtility(
  ownSymbols: readonly CardSymbol[],
  opposingSymbols: readonly CardSymbol[]
): number {
  const ownTriple = isTriple(ownSymbols);
  const opposingTriple = isTriple(opposingSymbols);
  let value = 0;
  for (let lane = 0; lane < 3; lane += 1) {
    let result = compareSymbols(ownSymbols[lane]!, opposingSymbols[lane]!);
    if (result === 0 && ownTriple !== opposingTriple) result = ownTriple ? 1 : -1;
    value += result;
  }
  return value;
}

function buildAdvancedRetentionModel(
  view: AdvancedShuffleView,
  random: RandomSource
): AdvancedRetentionModel {
  const sampled = sampleAllOpponentHands({
    copiesPerSymbol: view.copiesPerSymbol,
    observerHand: view.hand,
    opponents: view.opponents.map((opponent) => ({
      id: opponent.id,
      handCount: opponent.handCount,
      memory: opponent.memory,
      ...(opponent.currentRevealedSymbols
        ? { currentRevealedSymbols: opponent.currentRevealedSymbols }
        : {})
    }))
  }, random, view.sampleCount ?? 512);
  const expectedHeld = emptyCounts();
  for (const opponent of sampled) {
    for (const hand of opponent.hands) {
      expectedHeld.rock += hand.counts.rock * hand.probability;
      expectedHeld.paper += hand.counts.paper * hand.probability;
      expectedHeld.scissors += hand.counts.scissors * hand.probability;
    }
  }
  const ownCounts = countSymbols(view.hand.map((card) => card.symbol));
  const estimatedDeck = emptyCounts();
  for (const symbol of ["rock", "paper", "scissors"] as const) {
    estimatedDeck[symbol] = Math.max(view.copiesPerSymbol - ownCounts[symbol] - expectedHeld[symbol], 0);
  }
  const estimatedDeckTotal = totalCounts(estimatedDeck);
  const drawProbabilities = emptyCounts();
  if (estimatedDeckTotal > EPSILON) {
    for (const symbol of ["rock", "paper", "scissors"] as const) {
      drawProbabilities[symbol] = estimatedDeck[symbol] / estimatedDeckTotal;
    }
  }

  const activeOpponentIds = new Set(
    view.opponents.filter((opponent) => !opponent.eliminated).map((opponent) => opponent.id)
  );
  const activeOpponentCount = Math.max(activeOpponentIds.size, 1);
  const opponentCounts = new Map<string, { counts: Record<CardSymbol, number>; probability: number }>();
  for (const opponent of sampled) {
    if (!activeOpponentIds.has(opponent.id)) continue;
    for (const hand of opponent.hands) {
      const key = countKey(hand.counts);
      const probability = hand.probability / activeOpponentCount;
      const previous = opponentCounts.get(key);
      if (previous) previous.probability += probability;
      else opponentCounts.set(key, { counts: cloneCounts(hand.counts), probability });
    }
  }
  let opponentTypes: BayesianType<readonly CardSymbol[]>[] = [...opponentCounts.values()]
    .map(({ counts, probability }) => ({
      probability,
      actions: orderedSymbolSequences(cloneCounts(counts), 3)
    }))
    .filter((type) => type.actions.length > 0);
  if (opponentTypes.length === 0) {
    opponentTypes = [{
      probability: 1,
      actions: orderedSymbolSequences(emptyCounts(3), 3)
    }];
  } else {
    const probabilityTotal = opponentTypes.reduce((sum, type) => sum + type.probability, 0);
    opponentTypes = opponentTypes.map((type) => ({
      ...type,
      probability: type.probability / probabilityTotal
    }));
  }

  return {
    opponentTypes,
    drawProbabilities,
    sampleCount: sampled[0]?.hands.reduce((sum, hand) => sum + hand.samples, 0) ?? 0,
    showdownValue: Math.max(2, view.copiesPerSymbol - 4) * 10,
    handValues: new Map()
  };
}

function retainedHandValue(
  hand: readonly Card[],
  hp: number,
  model: AdvancedRetentionModel
): number {
  const showdown = hand.length === 5
    && hand[0] !== undefined
    && hand.every((card) => card.symbol === hand[0]!.symbol);
  if (showdown) return hp + model.showdownValue;
  const counts = countSymbols(hand.map((card) => card.symbol));
  const key = countKey(counts);
  const cached = model.handValues.get(key);
  if (cached !== undefined) return hp + cached;
  const ownSequences = orderedSymbolSequences(cloneCounts(counts), 3);
  const equilibrium = ownSequences.length === 0
    ? -3
    : solveBayesianMaximin(
        ownSequences,
        model.opponentTypes,
        (own, opposing) => sequenceUtility(own, opposing)
      ).value;
  model.handValues.set(key, equilibrium);
  return hp + equilibrium;
}

function bestAdvancedRetention(
  hand: readonly Card[],
  requiredDiscards: number,
  hp: number,
  model: AdvancedRetentionModel
): AdvancedRetentionChoice[] {
  if (requiredDiscards < 0 || requiredDiscards > hand.length) {
    throw new Error("Advanced computer discard count is invalid.");
  }
  const candidates = cardCombinations(hand, requiredDiscards).map((discarded) => {
    const discardedIds = new Set(discarded.map((card) => card.id));
    const remaining = hand.filter((card) => !discardedIds.has(card.id));
    return { discarded, value: retainedHandValue(remaining, hp, model) };
  });
  const bestValue = Math.max(...candidates.map((candidate) => candidate.value));
  return candidates.filter((candidate) => Math.abs(candidate.value - bestValue) <= 1e-7);
}

export function chooseAdvancedDraw(
  view: AdvancedShuffleView,
  random: RandomSource = Math.random
): AdvancedDrawAnalysis {
  const model = buildAdvancedRetentionModel(view, random);
  const skipChoices = bestAdvancedRetention(view.hand, view.requiredDiscards, view.hp, model);
  const skipValue = skipChoices[0]!.value;
  if (view.hp <= 1 || view.deckCount <= 0) {
    return {
      purchase: false,
      skipValue,
      purchaseValue: null,
      drawProbabilities: cloneCounts(model.drawProbabilities),
      sampleCount: model.sampleCount
    };
  }
  let purchaseValue = 0;
  for (const symbol of ["rock", "paper", "scissors"] as const) {
    const probability = model.drawProbabilities[symbol];
    if (probability <= EPSILON) continue;
    const drawnCard: Card = { id: `advanced-draw-${symbol}`, symbol };
    const choices = bestAdvancedRetention(
      [...view.hand, drawnCard],
      view.requiredDiscards + 1,
      view.hp - 1,
      model
    );
    purchaseValue += probability * choices[0]!.value;
  }
  return {
    purchase: purchaseValue > skipValue + EPSILON,
    skipValue,
    purchaseValue,
    drawProbabilities: cloneCounts(model.drawProbabilities),
    sampleCount: model.sampleCount
  };
}

export function chooseAdvancedTableDiscards(
  view: AdvancedShuffleView,
  random: RandomSource = Math.random
): string[] {
  const model = buildAdvancedRetentionModel(view, random);
  const best = bestAdvancedRetention(view.hand, view.requiredDiscards, view.hp, model);
  return best[Math.floor(random() * best.length)]!.discarded.map((card) => card.id);
}

export function chooseAdvancedPair(
  view: AdvancedPairView,
  random: RandomSource = Math.random
): AdvancedPairChoice {
  const committedIds = new Set(
    view.ownSlots.slice(0, view.activeLane).map((slot) => slot.cardId).filter((id): id is string => id !== null)
  );
  const representativeCards = new Map<CardSymbol, Card>();
  for (const card of view.hand) {
    if (!committedIds.has(card.id) && !representativeCards.has(card.symbol)) representativeCards.set(card.symbol, card);
  }
  if (representativeCards.size === 0) throw new Error("Advanced computer has no card available for this pair.");
  const tableOpponents = view.tableOpponents;
  const distribution = tableOpponents && view.opponentId
    ? sampleAllOpponentHands({
        copiesPerSymbol: view.copiesPerSymbol,
        observerHand: view.observerHand,
        opponents: tableOpponents
      }, random, view.sampleCount ?? 512).find((candidate) => candidate.id === view.opponentId)!.hands
    : sampleOpponentHands(view, random, view.sampleCount ?? 512);
  const ownPriorSymbols = view.ownSlots.slice(0, view.activeLane).map((slot) =>
    view.hand.find((card) => card.id === slot.cardId)?.symbol ?? null
  );
  const ownPriorHearts = view.ownSlots.slice(0, view.activeLane).map((slot) => slot.hearts);
  const rows = pairPlans(
    countSymbols(view.hand.map((card) => card.symbol)),
    ownPriorSymbols,
    ownPriorHearts,
    view.hp,
    { kind: "minimum", hearts: view.ownSlots[view.activeLane]?.hearts ?? 0 }
  );
  if (rows.length === 0) throw new Error("Advanced computer has no complete legal plan.");
  const revealed = [...(view.currentRevealedSymbols ?? [])].slice(0, view.activeLane);
  const opponentPriorHearts = view.opponentPositions
    .slice(0, view.activeLane)
    .map((position) => position.hearts);
  const opponentSequenceKeys = new Set<string>();
  let opponentPlanCount = 0;
  const types = distribution
    .map((sample) => {
      const actions = pairPlans(
        sample.counts,
        revealed,
        opponentPriorHearts,
        view.opponentHp,
        {
          kind: view.opponentLocked ? "exact" : "minimum",
          hearts: view.opponentPositions[view.activeLane]?.hearts ?? 0
        }
      );
      opponentPlanCount += actions.length;
      for (const action of actions) {
        opponentSequenceKeys.add(action.symbols.slice(view.activeLane).join(","));
      }
      return { probability: sample.probability, actions };
    })
    .filter((type) => type.actions.length > 0);
  const probabilityTotal = types.reduce((sum, type) => sum + type.probability, 0);
  const normalizedTypes = types.map((type) => ({ ...type, probability: type.probability / probabilityTotal }));
  if (normalizedTypes.length === 0) throw new Error("No sampled opponent hand has a complete legal plan.");
  const equilibrium = solveFullPlanMaximin(rows, normalizedTypes);
  const actionMap = new Map<string, AdvancedCurrentActionProbability>();
  for (let index = 0; index < rows.length; index += 1) {
    const probability = equilibrium.probabilities[index] ?? 0;
    if (probability <= EPSILON) continue;
    const plan = rows[index]!;
    const symbol = plan.symbols[view.activeLane]!;
    if (!symbol) continue;
    const hearts = plan.hearts[view.activeLane]!;
    const key = `${symbol}:${hearts}`;
    const previous = actionMap.get(key);
    if (previous) previous.probability += probability;
    else actionMap.set(key, { symbol, hearts, probability });
  }
  const currentActions = [...actionMap.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol) || left.hearts - right.hearts
  );
  const currentTotal = currentActions.reduce((sum, action) => sum + action.probability, 0);
  for (const action of currentActions) action.probability /= currentTotal;
  const selected = chooseByProbability(
    currentActions,
    currentActions.map((action) => action.probability),
    random
  );
  const nextCardProbabilities = emptyCounts();
  for (const sample of distribution) {
    const counts = cloneCounts(sample.counts);
    subtractSymbols(counts, revealed.filter((symbol): symbol is CardSymbol => symbol !== null));
    const total = totalCounts(counts);
    if (total <= 0) continue;
    for (const symbol of ["rock", "paper", "scissors"] as const) {
      nextCardProbabilities[symbol] += sample.probability * counts[symbol] / total;
    }
  }
  return {
    cardId: representativeCards.get(selected.symbol)!.id,
    hearts: selected.hearts,
    equilibriumValue: equilibrium.value,
    analysis: {
      sampledHands: distribution.map((sample) => ({
        counts: cloneCounts(sample.counts),
        samples: sample.samples,
        probability: sample.probability
      })),
      sampleCount: distribution.reduce((sum, sample) => sum + sample.samples, 0),
      nextCardProbabilities,
      ownPlanCount: rows.length,
      opponentSequenceCount: opponentSequenceKeys.size,
      opponentPlanCount,
      equilibriumIterations: equilibrium.iterations,
      currentActions
    }
  };
}

function cardCombinations(items: readonly Card[], size: number): Card[][] {
  const result: Card[][] = [];
  const visit = (start: number, selected: Card[]): void => {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      selected.push(items[index]!);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}

export function chooseAdvancedDiscards(
  hand: readonly Card[],
  requiredDiscards: number,
  random: RandomSource = Math.random
): string[] {
  if (requiredDiscards < 0 || requiredDiscards > hand.length) {
    throw new Error("Advanced computer discard count is invalid.");
  }
  if (requiredDiscards === 0) return [];
  const candidates = cardCombinations(hand, requiredDiscards).map((discarded) => {
    const ids = new Set(discarded.map((card) => card.id));
    const remaining = hand.filter((card) => !ids.has(card.id));
    const showdown = remaining.length === 5
      && remaining[0] !== undefined
      && remaining.every((card) => card.symbol === remaining[0]!.symbol);
    if (showdown) return { discarded, value: 2 };
    const ownSymbols = [...new Set(remaining.map((card) => card.symbol))];
    const value = solveBayesianMaximin(
      ownSymbols,
      [{ probability: 1, actions: ["rock", "paper", "scissors"] as const }],
      (own, opposing) => compareSymbols(own, opposing)
    ).value;
    return { discarded, value };
  });
  const bestValue = Math.max(...candidates.map((candidate) => candidate.value));
  const best = candidates.filter((candidate) => Math.abs(candidate.value - bestValue) <= 1e-7);
  return best[Math.floor(random() * best.length)]!.discarded.map((card) => card.id);
}
