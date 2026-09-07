import type { BayesianType, EquilibriumResult } from "./types.js";
import { EPSILON, LP_INFINITY } from "./common.js";

export class LinearProgram {
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
      if (targetRow[column] === 0) continue;
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
    const visited = new Set<string>();
    let bland = false;
    let pivotCount = 0;
    while (true) {
      if (++pivotCount > 5000) throw new Error("The equilibrium solver exceeded its numerical iteration budget.");
      if (!bland) {
        const basis = this.basic.join(",");
        bland = visited.has(basis);
        visited.add(basis);
      }
      let entering = -1;
      for (let column = 0; column <= this.variableCount; column += 1) {
        if (phase === 2 && this.nonBasic[column] === -1) continue;
        if (bland) {
          if (this.tableau[objectiveRow]![column]! < -EPSILON
            && (entering === -1 || this.nonBasic[column]! < this.nonBasic[entering]!)) entering = column;
          continue;
        }
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
        // Epsilon-equal ratios can pick a non-minimum row, lose feasibility,
        // and cycle. Keep ratio ordering strict, including before Bland mode.
        const ratio = this.tableau[row]![this.variableCount + 1]! / this.tableau[row]![entering]!;
        const previous = leaving === -1 ? Infinity
          : this.tableau[leaving]![this.variableCount + 1]! / this.tableau[leaving]![entering]!;
        if (ratio < previous || (ratio === previous && (leaving === -1 || this.basic[row]! < this.basic[leaving]!))) leaving = row;
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
