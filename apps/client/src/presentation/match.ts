import type { CardSymbol } from "@rps/game-core";
import type { MatchSnapshot, BattleSideView, ServerSnapshot, PublicPlayerView } from "@rps/protocol";
import type { ApplicationDependencies } from "../application.js";
import { browserClock } from "../clock.js";
import { cardBack } from "../views/components.js";
interface PresentationDependencies extends ApplicationDependencies {
  snapshot(): ServerSnapshot | null;
  render(): void;
}
export class MatchPresentation {
  private readonly app;
  private readonly effects;
  private readonly gameAudio;
  private readonly clock;
  constructor(private readonly dependencies: PresentationDependencies) {
    this.app = dependencies.app;
    this.effects = dependencies.effects;
    this.gameAudio = dependencies.audio;
    this.clock = dependencies.clock ?? browserClock;
  }
  private get snapshot() { return this.dependencies.snapshot(); }
  private render(): void { this.dependencies.render(); }
  dispose(): void { this.clearBattleTimers(); this.clearOutcomeTimer(); this.clearDrawTimers(); }
  activeBattleSequence: { key: string; startedAt: number; timers: number[] } | null = null;
  readonly completedBattleSequences = new Set<string>();
  activeOutcomeSequence: { key: string; startedAt: number; timer: number } | null = null;
  readonly completedOutcomeSequences = new Set<string>();
  readonly firedBattleMoments = new Set<string>();
  readonly animatedDrawCards = new Set<string>();
  readonly animatingDrawCards = new Set<string>();
  readonly revealedPairs = new Set<string>();
  readonly drawTimers: number[] = [];
  battleKey(view: MatchSnapshot): string | null {
    return view.battle ? `${view.roomCode}:${view.battle.round}` : null;
  }

  outcomeKey(view: MatchSnapshot): string {
    const outcome = view.outcome;
    return `${view.roomCode}:${view.round}:outcome:${outcome?.kind ?? "none"}:${outcome?.winnerId ?? "none"}:${outcome?.reason ?? "none"}`;
  }

  outcomeCrownDelay(view: MatchSnapshot): number {
    if (view.outcome?.reason !== "showdown") return 260;
    const shownHands = view.outcome.showdownSymbols?.filter((symbol) => symbol !== null).length ?? 0;
    return view.outcome.kind === "winner" && shownHands === 2 ? 3_250 : 1_750;
  }

  startOutcomeSequence(
    view: MatchSnapshot,
    self: PublicPlayerView,
    battleSequencePending: boolean
  ): void {
    if (view.phase !== "finished" || !view.outcome || battleSequencePending) return;
    this.positionShowdownOrigins();
    const key = this.outcomeKey(view);
    if (this.completedOutcomeSequences.has(key) || this.activeOutcomeSequence?.key === key) return;
    this.clearOutcomeTimer();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Hold the finished table for one additional second after the crown lands
    // before replacing it with the victory, draw, or defeat modal.
    const duration = reducedMotion ? 1_350 : this.outcomeCrownDelay(view) + 2_450;
    const startedAt = this.clock.elapsed();
    const timer = this.clock.setTimeout(() => {
      this.completedOutcomeSequences.add(key);
      this.activeOutcomeSequence = null;
      this.gameAudio.playOutcome(
        view.outcome!.kind === "draw" ? "draw" : view.outcome!.winnerId === self.id ? "win" : "loss"
      );
      if (this.snapshot?.kind === "match" && this.outcomeKey(this.snapshot) === key) this.render();
    }, duration);
    this.activeOutcomeSequence = { key, startedAt, timer };
  }

  positionShowdownOrigins(): void {
    const felt = this.app.querySelector<HTMLElement>(".outcome-felt");
    if (!felt) return;
    const feltRect = felt.getBoundingClientRect();
    if (feltRect.width === 0 || feltRect.height === 0) return;
    const sources = [...this.app.querySelectorAll<HTMLElement>("[data-card-source-player]")];
    this.app.querySelectorAll<HTMLElement>("[data-showdown-player]").forEach((card) => {
      const source = sources.find((candidate) => candidate.dataset.cardSourcePlayer === card.dataset.showdownPlayer);
      if (!source) return;
      const sourceRect = source.getBoundingClientRect();
      const x = (sourceRect.left + sourceRect.width / 2 - feltRect.left) / feltRect.width * 100;
      const y = (sourceRect.top + sourceRect.height / 2 - feltRect.top) / feltRect.height * 100;
      card.style.setProperty("--card-from-x", `${x.toFixed(2)}%`);
      card.style.setProperty("--card-from-y", `${y.toFixed(2)}%`);
    });
  }

  drawCardKey(view: MatchSnapshot, cardId: string): string {
    return `${view.roomCode}:${view.round}:draw:${cardId}`;
  }

  startPairReveal(view: MatchSnapshot): void {
    const revealedIndex = view.phase === "preparation"
      ? view.activeLane - 1
      : view.battle
        ? 2
        : -1;
    if (revealedIndex < 0) return;
    const key = `${view.roomCode}:${view.round}:pair:${revealedIndex}`;
    if (this.revealedPairs.has(key)) return;
    this.revealedPairs.add(key);
    this.app.querySelector<HTMLElement>(`.battle-lane[data-slot="${revealedIndex}"]`)
      ?.classList.add("pair-just-revealed");
    if (view.phase === "preparation") this.gameAudio.playReveal();
  }

  startDrawSequence(view: MatchSnapshot): void {
    if (view.phase !== "discard" || view.self.drawnCardIds.length === 0) return;
    const freshDraws = view.self.drawnCardIds.filter(
      (cardId) => {
        const key = this.drawCardKey(view, cardId);
        return !this.animatedDrawCards.has(key) && !this.animatingDrawCards.has(key);
      }
    );
    if (freshDraws.length === 0) return;
    for (const cardId of freshDraws) this.animatingDrawCards.add(this.drawCardKey(view, cardId));

    const deck = this.app.querySelector<HTMLElement>(".deck-count");
    if (!deck) {
      for (const cardId of freshDraws) {
        const key = this.drawCardKey(view, cardId);
        this.animatingDrawCards.delete(key);
        this.animatedDrawCards.add(key);
      }
      this.app.querySelectorAll<HTMLElement>(".draw-pending").forEach((card) => card.classList.remove("draw-pending"));
      return;
    }

    const deckRect = deck.getBoundingClientRect();
    const startCenterX = deckRect.left + deckRect.width / 2;
    const startCenterY = deckRect.top + deckRect.height / 2;
    freshDraws.forEach((cardId, index) => {
      const target = this.app.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
      if (!target) {
        const key = this.drawCardKey(view, cardId);
        this.animatingDrawCards.delete(key);
        this.animatedDrawCards.add(key);
        return;
      }
      const targetRect = target.getBoundingClientRect();
      const startX = startCenterX - targetRect.width / 2;
      const startY = startCenterY - targetRect.height / 2;
      const deltaX = targetRect.left - startX;
      const deltaY = targetRect.top - startY;
      const delay = index * 260;

      const flight = document.createElement("div");
      flight.className = "draw-card-flight board-card back";
      flight.innerHTML = cardBack();
      flight.style.left = `${startX}px`;
      flight.style.top = `${startY}px`;
      flight.style.width = `${targetRect.width}px`;
      flight.style.height = `${targetRect.height}px`;
      flight.style.setProperty("--draw-x", `${deltaX}px`);
      flight.style.setProperty("--draw-y", `${deltaY}px`);
      flight.style.setProperty("--draw-mid-x", `${deltaX / 2 + (index % 2 === 0 ? -25 : 25)}px`);
      flight.style.setProperty("--draw-mid-y", `${deltaY / 2 - 38}px`);
      flight.style.animationDelay = `${delay}ms`;
      document.body.append(flight);
      this.gameAudio.playDraw(delay);
      flight.addEventListener("animationend", () => flight.remove(), { once: true });

      const timer = this.clock.setTimeout(() => {
        const key = this.drawCardKey(view, cardId);
        this.animatingDrawCards.delete(key);
        this.animatedDrawCards.add(key);
        const current = this.app.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
        if (!current) return;
        current.classList.remove("draw-pending");
        current.classList.add("draw-arrived");
        current.addEventListener("animationend", () => current.classList.remove("draw-arrived"), { once: true });
      }, delay + 830);
      this.drawTimers.push(timer);
    });
  }

  animateDiscardToDeck(card: HTMLElement): void {
    const deck = this.app.querySelector<HTMLElement>(".deck-count");
    if (!deck) return;
    const start = card.getBoundingClientRect();
    const end = deck.getBoundingClientRect();
    const deltaX = end.left + end.width / 2 - (start.left + start.width / 2);
    const deltaY = end.top + end.height / 2 - (start.top + start.height / 2);
    const flight = card.cloneNode(true) as HTMLElement;
    flight.classList.remove("selected", "discard-selected", "draw-pending", "draw-arrived");
    flight.classList.add("discard-card-flight");
    flight.removeAttribute("data-card-id");
    flight.removeAttribute("draggable");
    flight.style.left = `${start.left}px`;
    flight.style.top = `${start.top}px`;
    flight.style.width = `${start.width}px`;
    flight.style.height = `${start.height}px`;
    flight.style.setProperty("--discard-x", `${deltaX}px`);
    flight.style.setProperty("--discard-y", `${deltaY}px`);
    flight.style.setProperty("--discard-mid-x", `${deltaX / 2 + 42}px`);
    flight.style.setProperty("--discard-mid-y", `${deltaY / 2 - 42}px`);
    card.classList.add("discard-launching");
    document.body.append(flight);
    flight.addEventListener("animationend", () => {
      flight.remove();
      const currentDeck = this.app.querySelector<HTMLElement>(".deck-count");
      if (!currentDeck) return;
      currentDeck.classList.remove("deck-receive");
      void currentDeck.offsetWidth;
      currentDeck.classList.add("deck-receive");
      currentDeck.addEventListener("animationend", () => currentDeck.classList.remove("deck-receive"), { once: true });
    }, { once: true });
  }

  shouldAnimateBattle(view: MatchSnapshot): boolean {
    const key = this.battleKey(view);
    if (!key || this.completedBattleSequences.has(key)) return false;
    return view.phase === "battle" || (view.phase === "finished" && view.outcome?.reason === "hp");
  }

  hpBeforeBattle(view: MatchSnapshot, playerId: string): number {
    if (!view.battle) return view.players.find((player) => player.id === playerId)?.hp ?? 0;
    const playerIndex = view.battle.duelistIds.indexOf(playerId);
    if (playerIndex < 0) return view.players.find((player) => player.id === playerId)?.hp ?? 0;
    const placed = view.battle.lanes.reduce((total, lane) => {
      return total + (lane.sides.find((side) => side.playerId === playerId)?.hearts ?? 0);
    }, 0);
    return placed + view.battle.unassignedLost[playerIndex]!;
  }

  bottomDuelistId(view: MatchSnapshot): string {
    if (!view.battle) return view.selfPlayerId;
    return view.battle.duelistIds.includes(view.selfPlayerId)
      ? view.selfPlayerId
      : view.battle.duelistIds[0];
  }

  startBattleSequence(view: MatchSnapshot): void {
    if (!this.shouldAnimateBattle(view) || !view.battle) {
      if (this.activeBattleSequence && this.activeBattleSequence.key !== this.battleKey(view)) {
        this.clearBattleTimers();
      }
      return;
    }

    const key = this.battleKey(view)!;
    if (!this.activeBattleSequence || this.activeBattleSequence.key !== key) {
      this.clearBattleTimers();
      this.activeBattleSequence = { key, startedAt: this.clock.elapsed(), timers: [] };
    } else {
      for (const timer of this.activeBattleSequence.timers) this.clock.clearTimeout(timer);
      this.activeBattleSequence.timers = [];
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gap = reducedMotion ? 100 : 1_170;
    const clashOffset = reducedMotion ? 30 : 300;
    const resolveOffset = reducedMotion ? 65 : 690;
    // Leave the final lane visible until its transfer feedback has finished,
    // then hold the completed battle for five seconds before totals and any
    // final match outcome are shown.
    const animationFinishOffset = reducedMotion ? 110 : 2_010;
    const finishOffset = animationFinishOffset + 5_000;
    const elapsed = this.clock.elapsed() - this.activeBattleSequence.startedAt;

    view.battle.lanes.forEach((lane, index) => {
      const revealAt = index * gap;
      this.scheduleBattleMoment(revealAt - elapsed, () => this.revealLane(index));
      this.scheduleBattleMoment(revealAt + clashOffset - elapsed, () => {
        this.clashLane(view, index, key);
      });
      this.scheduleBattleMoment(revealAt + resolveOffset - elapsed, () => {
        this.resolveLane(view, index, key);
      });
    });

    const lastLaneAt = (view.battle.lanes.length - 1) * gap;
    const collectionAt = lastLaneAt + animationFinishOffset;
    const collectionGap = 1_350;
    const collectionLeadIn = 350;
    const collectionTravel = reducedMotion ? 30 : 900;
    this.scheduleBattleMoment(collectionAt - elapsed, () => this.prepareHeartCollection(view));
    view.battle.lanes.forEach((lane, index) => {
      const departAt = collectionAt + collectionLeadIn + index * collectionGap;
      this.scheduleBattleMoment(departAt - elapsed, () => this.collectLaneHearts(view, index, key));
      this.scheduleBattleMoment(departAt + collectionTravel - elapsed, () => {
        this.settleLaneHearts(view, index);
      });
    });

    const completeAt = lastLaneAt + finishOffset;
    this.scheduleBattleMoment(completeAt - elapsed, () => {
      this.completedBattleSequences.add(key);
      this.clearBattleTimers();
      if (this.snapshot?.kind === "match" && this.battleKey(this.snapshot) === key) this.render();
    });
  }

  scheduleBattleMoment(delay: number, callback: () => void): void {
    if (delay <= 0) {
      callback();
      return;
    }
    const timer = this.clock.setTimeout(callback, delay);
    this.activeBattleSequence?.timers.push(timer);
  }

  revealLane(index: number): void {
    this.app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`)?.classList.add("lane-revealing");
    this.gameAudio.playReveal();
  }

  clashLane(view: MatchSnapshot, index: number, key: string): void {
    const laneElement = this.app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    const lane = view.battle?.lanes[index];
    const selfSide = lane?.sides.find((side) => side.playerId === this.bottomDuelistId(view));
    if (!laneElement || !lane || !selfSide) return;
    laneElement.classList.add("lane-clashing");
    laneElement.querySelector<HTMLElement>(".versus-line b")!.textContent = "CLASH";
    const moment = `${key}:clash:${index}`;
    if (!this.firedBattleMoments.has(moment)) {
      this.firedBattleMoments.add(moment);
      const clash = laneElement.querySelector<HTMLElement>(".versus-line")?.getBoundingClientRect()
        ?? laneElement.getBoundingClientRect();
      this.effects.events.emit("lane-clash-fx", {
        laneIndex: index,
        outcome: selfSide.result,
        x: clash.left + clash.width / 2,
        y: clash.top + clash.height / 2
      });
      const symbols = lane.sides.map((side) => side.symbol).filter((symbol): symbol is CardSymbol => symbol !== null);
      if (symbols.length === 2) this.gameAudio.playClash(symbols[0]!, symbols[1]!);
    }
  }

  resolveLane(view: MatchSnapshot, index: number, key: string): void {
    const laneElement = this.app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    const lane = view.battle?.lanes[index];
    if (!laneElement || !lane) return;
    const bottomId = this.bottomDuelistId(view);
    const selfSide = lane.sides.find((side) => side.playerId === bottomId);
    const opponentSide = lane.sides.find((side) => side.playerId !== bottomId);
    if (!selfSide || !opponentSide) return;

    laneElement.classList.remove("lane-clashing");
    laneElement.classList.add("lane-resolved", `result-${selfSide.result}`);
    laneElement.querySelector<HTMLElement>(".versus-line b")!.textContent = selfSide.result.toUpperCase();
    const moment = `${key}:transfer:${index}`;
    const animate = !this.firedBattleMoments.has(moment);
    if (animate) this.firedBattleMoments.add(moment);
    this.applyHeartResult(laneElement, selfSide, opponentSide, animate);
  }

  applyHeartResult(
    laneElement: HTMLElement,
    selfSide: BattleSideView,
    opponentSide: BattleSideView,
    animate: boolean
  ): void {
    const selfBadge = laneElement.querySelector<HTMLElement>('[data-lane-heart="self"]');
    const opponentBadge = laneElement.querySelector<HTMLElement>('[data-lane-heart="opponent"]');
    if (!selfBadge || !opponentBadge) return;

    const winner = selfSide.result === "win" ? selfSide : opponentSide.result === "win" ? opponentSide : null;
    const loser = winner === selfSide ? opponentSide : winner === opponentSide ? selfSide : null;
    if (animate && winner && loser) {
      const amount = Math.max(winner.receivedHp - winner.hearts, 0);
      const from = winner === selfSide ? opponentBadge : selfBadge;
      const to = winner === selfSide ? selfBadge : opponentBadge;
      if (amount > 0) this.flyHearts(from, to, amount, winner === selfSide);
      if (loser.hearts > 0) this.burnHeart(from, laneElement);
    }

    selfBadge.textContent = `♥ ${selfSide.receivedHp}`;
    opponentBadge.textContent = `♥ ${opponentSide.receivedHp}`;
  }

  prepareHeartCollection(view: MatchSnapshot): void {
    this.app.querySelector<HTMLElement>(".battle-grid")?.classList.add("hearts-collecting");
    const message = this.app.querySelector<HTMLElement>(".reveal-message");
    if (message) message.textContent = "Collecting each card's hearts into total HP…";
    for (const playerId of view.battle?.duelistIds ?? []) {
      const total = this.app.querySelector<HTMLElement>(`[data-duelist-total-player="${playerId}"] .duelist-hp`);
      if (!total) continue;
      total.textContent = "♥ 0";
      total.classList.add("hp-collecting");
    }
  }

  collectLaneHearts(view: MatchSnapshot, index: number, key: string): void {
    const lane = view.battle?.lanes[index];
    const laneElement = this.app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    if (!lane || !laneElement) return;
    laneElement.classList.add("lane-collecting");

    const moment = `${key}:collect:${index}`;
    const animate = !this.firedBattleMoments.has(moment);
    if (animate) this.firedBattleMoments.add(moment);

    for (const side of lane.sides) {
      const isSelf = side.playerId === this.bottomDuelistId(view);
      const source = laneElement.querySelector<HTMLElement>(
        `[data-lane-heart="${isSelf ? "self" : "opponent"}"]`
      );
      const target = this.app.querySelector<HTMLElement>(`[data-duelist-total-player="${side.playerId}"] .duelist-hp`);
      if (!source || !target) continue;
      source.classList.add("hearts-departing");
      if (animate && side.receivedHp > 0) {
        this.flyCollectedHearts(source, target, side.receivedHp, isSelf);
      }
    }
  }

  settleLaneHearts(view: MatchSnapshot, index: number): void {
    const lane = view.battle?.lanes[index];
    const laneElement = this.app.querySelector<HTMLElement>(`.battle-lane[data-slot="${index}"]`);
    if (!lane || !laneElement || !view.battle) return;
    laneElement.classList.remove("lane-collecting");
    laneElement.classList.add("lane-collected");

    for (const side of lane.sides) {
      const isSelf = side.playerId === this.bottomDuelistId(view);
      const source = laneElement.querySelector<HTMLElement>(
        `[data-lane-heart="${isSelf ? "self" : "opponent"}"]`
      );
      if (source) {
        source.textContent = "♥ 0";
        source.classList.remove("hearts-departing");
        source.classList.add("hearts-collected");
      }

      const collected = view.battle.lanes.slice(0, index + 1).reduce((total, currentLane) => {
        return total + (currentLane.sides.find((candidate) => candidate.playerId === side.playerId)?.receivedHp ?? 0);
      }, 0);
      const target = this.app.querySelector<HTMLElement>(`[data-duelist-total-player="${side.playerId}"] .duelist-hp`);
      if (!target) continue;
      target.textContent = `♥ ${collected}`;
      target.classList.remove("hp-receiving");
      void target.offsetWidth;
      target.classList.add("hp-receiving");
      target.addEventListener("animationend", () => target.classList.remove("hp-receiving"), { once: true });
    }
  }

  flyCollectedHearts(from: HTMLElement, to: HTMLElement, amount: number, towardSelf: boolean): void {
    const start = from.getBoundingClientRect();
    const end = to.getBoundingClientRect();
    const startX = start.left + start.width / 2;
    const startY = start.top + start.height / 2;
    const deltaX = end.left + end.width / 2 - startX;
    const deltaY = end.top + end.height / 2 - startY;
    const bundle = document.createElement("span");
    bundle.className = `collected-heart ${towardSelf ? "toward-self" : "toward-opponent"}`;
    bundle.innerHTML = `<b>♥</b><small>${amount}</small>`;
    bundle.style.left = `${startX}px`;
    bundle.style.top = `${startY}px`;
    bundle.style.setProperty("--collect-x", `${deltaX}px`);
    bundle.style.setProperty("--collect-y", `${deltaY}px`);
    bundle.style.setProperty("--collect-mid-x", `${deltaX / 2 + (towardSelf ? 22 : -22)}px`);
    bundle.style.setProperty("--collect-mid-y", `${deltaY / 2 - 28}px`);
    document.body.append(bundle);
    this.gameAudio.playHeartTing(0, amount);
    this.gameAudio.playHeartTing(760, amount + 1);
    bundle.addEventListener("animationend", () => bundle.remove(), { once: true });
  }

  flyHearts(from: HTMLElement, to: HTMLElement, amount: number, towardSelf: boolean): void {
    const start = from.getBoundingClientRect();
    const end = to.getBoundingClientRect();
    const startX = start.left + start.width / 2;
    const startY = start.top + start.height / 2;
    const endX = end.left + end.width / 2;
    const endY = end.top + end.height / 2;
    const particleCount = Math.min(amount, 6);

    for (let index = 0; index < particleCount; index += 1) {
      const heart = document.createElement("span");
      heart.className = "flying-heart";
      heart.textContent = "♥";
      heart.style.left = `${startX}px`;
      heart.style.top = `${startY}px`;
      heart.style.setProperty("--heart-x", `${endX - startX}px`);
      heart.style.setProperty("--heart-y", `${endY - startY}px`);
      heart.style.setProperty("--heart-mid-x", `${(endX - startX) / 2}px`);
      heart.style.setProperty(
        "--heart-mid-y",
        `${(endY - startY) / 2 + (index % 2 === 0 ? -1 : 1) * (18 + index * 4)}px`
      );
      heart.style.animationDelay = `${index * 55}ms`;
      document.body.append(heart);
      this.gameAudio.playHeartTing(index * 55, index);
      heart.addEventListener("animationend", () => heart.remove(), { once: true });
    }

    const count = document.createElement("span");
    count.className = `heart-transfer-count ${towardSelf ? "toward-self" : "toward-opponent"}`;
    count.textContent = `+${amount} HP`;
    count.style.left = `${endX}px`;
    count.style.top = `${endY}px`;
    document.body.append(count);
    count.addEventListener("animationend", () => count.remove(), { once: true });
  }

  burnHeart(from: HTMLElement, laneElement: HTMLElement): void {
    const source = from.getBoundingClientRect();
    const lane = laneElement.getBoundingClientRect();
    const burned = document.createElement("span");
    burned.className = "burned-heart";
    burned.innerHTML = "♥<small>−1</small>";
    burned.style.left = `${source.left + source.width / 2}px`;
    burned.style.top = `${lane.top + lane.height / 2}px`;
    document.body.append(burned);
    burned.addEventListener("animationend", () => burned.remove(), { once: true });
  }

  clearBattleTimers(): void {
    if (!this.activeBattleSequence) return;
    for (const timer of this.activeBattleSequence.timers) this.clock.clearTimeout(timer);
    this.activeBattleSequence = null;
  }

  clearOutcomeTimer(): void {
    if (!this.activeOutcomeSequence) return;
    this.clock.clearTimeout(this.activeOutcomeSequence.timer);
    this.activeOutcomeSequence = null;
  }

  clearDrawTimers(): void {
    for (const timer of this.drawTimers) this.clock.clearTimeout(timer);
    this.drawTimers.length = 0;
    document.querySelectorAll(".draw-card-flight, .discard-card-flight").forEach((element) => element.remove());
  }
}
