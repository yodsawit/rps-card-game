import type { CardSymbol } from "@rps/game-core";
import type { MatchSnapshot } from "@rps/protocol";
export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]!);
}

export function symbolLabel(symbol: CardSymbol): string {
  return symbol[0]!.toUpperCase() + symbol.slice(1);
}

export function symbolGraphic(symbol: CardSymbol): string {
  if (symbol === "rock") {
    return '<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M14 49 20 25 38 13 59 21 69 43 55 65 27 67Z"/><path class="detail" d="m20 26 18 14 21-18M38 40l-11 27m11-27 17 25"/></svg>';
  }
  if (symbol === "paper") {
    return '<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M20 9h29l13 14v48H20Z"/><path class="detail" d="M49 9v15h13M29 36h24M29 47h24M29 58h17"/></svg>';
  }
  return '<svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="24" cy="57" r="11"/><circle cx="51" cy="58" r="11"/><path d="m31 50 28-39M44 48 20 11"/><circle cx="38" cy="42" r="3"/></svg>';
}

export function cardFace(symbol: CardSymbol, compact = false): string {
  return `
    <span class="card-corner">${symbol[0]!.toUpperCase()}</span>
    <span class="card-symbol ${symbol}">${symbolGraphic(symbol)}</span>
    ${compact ? "" : `<span class="card-name">${symbolLabel(symbol)}</span>`}
  `;
}

export function cardBack(): string {
  return '<span class="back-mark"><i>R</i><i>P</i><i>S</i></span>';
}

export function phaseLabel(phase: MatchSnapshot["phase"]): string {
  if (phase === "targeting") return "CHOOSE TARGET";
  if (phase === "preparation") return "PREPARE";
  if (phase === "battle") return "REVEAL";
  if (phase === "discard") return "RESHUFFLE";
  return "MATCH END";
}
