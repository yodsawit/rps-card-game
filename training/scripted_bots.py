"""Production-aligned scripted opponents for RL training.

ARC mirrors the server's basic bot at symbol level. The advanced controller
uses public-memory hand sampling and an approximate Bayesian maximin solver.
The TypeScript promotion gate remains authoritative: this module is a fast
training opponent, not a second rules engine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
import math
import random
from typing import Iterable, Optional

from training.rps_env import HEART_LEVELS, RPSCardEnv, SYMBOL_COUNT, compare_symbols


@dataclass
class ScriptedBotState:
    discard_plans: dict[tuple[str, int, int], list[int]] = field(default_factory=dict)


def _legal_actions(mask: list[bool]) -> list[int]:
    return [index for index, allowed in enumerate(mask) if allowed]


def _counts(cards: Iterable[int]) -> tuple[int, int, int]:
    values = [0, 0, 0]
    for card in cards:
        values[card] += 1
    return values[0], values[1], values[2]


def _counter(symbol: int) -> int:
    return (symbol + 1) % SYMBOL_COUNT


def _defeated(symbol: int) -> int:
    return (symbol - 1) % SYMBOL_COUNT


def _weighted_choice(values: list[tuple[int, float]], rng: random.Random) -> int:
    total = sum(max(weight, 0.0) for _, weight in values)
    if total <= 0:
        return rng.choice([value for value, _ in values])
    roll = rng.random() * total
    for value, weight in values:
        roll -= max(weight, 0.0)
        if roll <= 0:
            return value
    return values[-1][0]


def _remaining_hand_score(hand: list[int]) -> float:
    counts = sorted((count for count in _counts(hand) if count), reverse=True)
    if len(hand) == 5 and counts and counts[0] == 5:
        return 10_000.0
    diversity = 24 if len(counts) == 3 else 0
    triple = 35 if counts and counts[0] >= 3 else 0
    collection = (counts[0] if counts else 0) * 12 + (counts[1] if len(counts) > 1 else 0) * 3
    return float(diversity + triple + collection)


def _discard_candidates(hand: list[int], amount: int) -> list[tuple[list[int], list[int]]]:
    candidates: list[tuple[list[int], list[int]]] = []
    for indices in combinations(range(len(hand)), amount):
        selected = set(indices)
        candidates.append((
            [hand[index] for index in indices],
            [card for index, card in enumerate(hand) if index not in selected],
        ))
    return candidates


def _repeated_triple(env: RPSCardEnv, opponent: int) -> Optional[int]:
    histories = env.histories[opponent][-2:]
    if len(histories) < 2:
        return None
    first, second = histories
    if len(set(first.symbols)) == 1 and first.symbols == second.symbols:
        return first.symbols[0]
    return None


def _arc_discard_plan(
    env: RPSCardEnv,
    player_index: int,
    rng: random.Random,
) -> list[int]:
    player = env.players[player_index]
    amount = player.required_discards
    hand_counts = _counts(player.hand)
    largest = max(hand_counts)
    dominant = {symbol for symbol, count in enumerate(hand_counts) if count == largest}
    pursue_four_one = len(player.hand) - amount == 5 and rng.random() < 0.3
    survival = player.recent_loss_ratio >= 0.5
    ranked: list[tuple[float, list[int]]] = []
    for discarded, remaining in _discard_candidates(player.hand, amount):
        remaining_counts = _counts(remaining)
        four_symbol = next((symbol for symbol, count in enumerate(remaining_counts) if count == 4), None)
        one_symbol = next((symbol for symbol, count in enumerate(remaining_counts) if count == 1), None)
        favorable_four_one = four_symbol is not None and one_symbol == _defeated(four_symbol)
        score = (
            _remaining_hand_score(remaining)
            + (1_000 if pursue_four_one and favorable_four_one else 0)
            + (80 * sum(card in dominant for card in discarded) if survival else 0)
            + rng.random()
        )
        ranked.append((score, discarded))
    return max(ranked, key=lambda item: item[0])[1]


def arc_action(
    env: RPSCardEnv,
    player_index: int,
    legal_mask: list[bool],
    rng: random.Random,
    state: ScriptedBotState,
) -> int:
    """Choose an action using the production ARC rules at symbol level."""
    legal = _legal_actions(legal_mask)
    player = env.players[player_index]
    if env.phase == "buy":
        largest = max(_counts(player.hand))
        if not legal_mask[1]:
            return 0
        if largest >= 4:
            return 1
        if player.recent_loss_ratio >= 0.5 and player.hp >= 3:
            return int(rng.random() < min(0.98, 0.7 + player.recent_loss_ratio * 0.28))
        if largest >= 3 and player.hp >= 5:
            return int(rng.random() < 0.75)
        return int(player.hp >= 8 and rng.random() < 0.35)

    if env.phase == "discard":
        key = ("arc", player_index, env.round)
        if key not in state.discard_plans:
            state.discard_plans[key] = _arc_discard_plan(env, player_index, rng)
        return state.discard_plans[key].pop(0)

    legal_symbols = sorted({action // HEART_LEVELS for action in legal})
    previous = [card for card in player.cards[: env.lane] if card is not None]
    opponent = 1 - player_index
    known = env.histories[opponent][-1].symbols if env.histories[opponent] else ()
    known_counts = _counts(known)
    repeated_triple = _repeated_triple(env, opponent)
    repeated_counter = _counter(repeated_triple) if repeated_triple is not None else None
    used = set(previous)
    building_triple = bool(previous) and len(set(previous)) == 1

    ranked: list[tuple[float, int, int, int]] = []
    for symbol in legal_symbols:
        favorable = known_counts[_defeated(symbol)]
        dangerous = known_counts[_counter(symbol)]
        score = (
            (35 if building_triple and symbol == previous[0] else 0)
            + (16 if symbol not in used else 0)
            + (500 if symbol == repeated_counter else 0)
            + favorable * 12
            - dangerous * 7
            + rng.random() * 8
        )
        ranked.append((score, symbol, favorable, dangerous))
    _, symbol, favorable, dangerous = max(ranked)
    remaining = player.hp - sum(player.hearts)
    if env.lane == 2 or symbol == repeated_counter:
        hearts = remaining
    else:
        pairs_remaining = 3 - env.lane
        baseline = remaining // pairs_remaining
        visible_stake = env.players[opponent].hearts[env.lane]
        pressure = 1 if visible_stake > baseline else 0 if visible_stake == 0 else -1
        maximum = max(remaining - (pairs_remaining - 1), 0)
        hearts = min(max(baseline + pressure + favorable - dangerous, 0), maximum)
    candidate = symbol * HEART_LEVELS + hearts
    if legal_mask[candidate]:
        return candidate
    same_symbol = [action for action in legal if action // HEART_LEVELS == symbol]
    return min(same_symbol or legal, key=lambda action: abs(action % HEART_LEVELS - hearts))


def _draw_cards(pool: list[int], amount: int, rng: random.Random) -> Optional[list[int]]:
    if amount > len(pool):
        return None
    source = pool[:]
    drawn: list[int] = []
    for _ in range(amount):
        drawn.append(source.pop(rng.randrange(len(source))))
    return drawn


def _sample_opponent_hands(
    env: RPSCardEnv,
    perspective: int,
    rng: random.Random,
    sample_count: int = 48,
) -> list[tuple[tuple[int, int, int], float]]:
    opponent = 1 - perspective
    player = env.players[perspective]
    opposing = env.players[opponent]
    public_pool = [
        symbol
        for symbol in range(SYMBOL_COUNT)
        for _ in range(env.copies_per_symbol - player.hand.count(symbol))
    ]
    history = env.histories[opponent][-1] if env.histories[opponent] else None
    current_draw_count = opposing.drawn_count if env.phase in ("buy", "discard") else None
    revealed = [
        card
        for lane, card in enumerate(opposing.cards)
        if card is not None and (env.phase != "battle" or lane < env.lane)
    ]
    hits: dict[tuple[int, int, int], int] = {}
    attempts = 0
    while sum(hits.values()) < sample_count and attempts < sample_count * 12:
        attempts += 1
        pool = public_pool[:]
        if history:
            visible = list(history.symbols)
            if any(card not in pool for card in visible):
                continue
            for card in visible:
                pool.remove(card)
            extras = _draw_cards(pool, history.hand_count - len(visible), rng)
            if extras is None:
                continue
            hand = visible + extras
            for _ in range(history.drawn_count if current_draw_count is None else current_draw_count):
                remaining_pool = public_pool[:]
                for card in hand:
                    if card in remaining_pool:
                        remaining_pool.remove(card)
                drawn = _draw_cards(remaining_pool, 1, rng)
                if not drawn:
                    break
                hand.extend(drawn)
            for _ in range(history.discarded_count):
                if hand:
                    hand.pop(rng.randrange(len(hand)))
        else:
            hand = _draw_cards(pool, len(opposing.hand), rng) or []
        if len(hand) != len(opposing.hand) or any(hand.count(card) < revealed.count(card) for card in range(SYMBOL_COUNT)):
            continue
        key = _counts(hand)
        hits[key] = hits.get(key, 0) + 1
    if not hits:
        fallback = _draw_cards(public_pool, len(opposing.hand), rng) or [0, 1, 2]
        hits[_counts(fallback)] = 1
    total = sum(hits.values())
    return [(counts, hits[counts] / total) for counts in sorted(hits)]


def _ordered_sequences(counts: tuple[int, int, int], prefix: tuple[int, ...] = ()) -> list[tuple[int, int, int]]:
    remaining = list(counts)
    for symbol in prefix:
        remaining[symbol] -= 1
        if remaining[symbol] < 0:
            return []
    sequences: list[tuple[int, int, int]] = []

    def visit(current: list[int]) -> None:
        if len(current) == 3:
            sequences.append((current[0], current[1], current[2]))
            return
        for symbol in range(SYMBOL_COUNT):
            if remaining[symbol] > 0:
                remaining[symbol] -= 1
                current.append(symbol)
                visit(current)
                current.pop()
                remaining[symbol] += 1

    visit(list(prefix))
    return sequences


def _sequence_utility(own: tuple[int, int, int], opposing: tuple[int, int, int]) -> float:
    own_triple = len(set(own)) == 1
    opposing_triple = len(set(opposing)) == 1
    value = 0.0
    for own_card, opposing_card in zip(own, opposing):
        result = compare_symbols(own_card, opposing_card)
        if result == 0 and own_triple != opposing_triple:
            result = 1 if own_triple else -1
        value += result
    return value


def _bayesian_maximin(
    rows: list[tuple[int, int, int]],
    opponent_types: list[tuple[tuple[int, int, int], float]],
    iterations: int = 32,
    column_prefix: tuple[int, ...] = (),
) -> tuple[list[float], float]:
    """Approximate the server LP with exponentiated subgradient ascent."""
    if not rows:
        return [], -3.0
    type_actions = [
        (_ordered_sequences(counts, column_prefix), probability)
        for counts, probability in opponent_types
    ]
    weights = [1.0] * len(rows)
    average = [0.0] * len(rows)
    eta = 0.35 / math.sqrt(max(len(rows), 1))
    for _ in range(iterations):
        total = sum(weights)
        policy = [weight / total for weight in weights]
        for index, probability in enumerate(policy):
            average[index] += probability
        gradient = [0.0] * len(rows)
        for actions, type_probability in type_actions:
            if not actions:
                continue
            worst = min(
                actions,
                key=lambda action: sum(
                    policy[index] * _sequence_utility(row, action)
                    for index, row in enumerate(rows)
                ),
            )
            for index, row in enumerate(rows):
                gradient[index] += type_probability * _sequence_utility(row, worst)
        peak = max(gradient)
        weights = [
            max(1.0e-12, weight * math.exp(eta * (value - peak)))
            for weight, value in zip(weights, gradient)
        ]
    policy = [value / iterations for value in average]
    value = 0.0
    for actions, type_probability in type_actions:
        if actions:
            value += type_probability * min(
                sum(policy[index] * _sequence_utility(row, action) for index, row in enumerate(rows))
                for action in actions
            )
    return policy, value


def _advanced_model(
    env: RPSCardEnv,
    player_index: int,
    rng: random.Random,
) -> tuple[list[tuple[tuple[int, int, int], float]], tuple[float, float, float]]:
    types = _sample_opponent_hands(env, player_index, rng)
    expected_opponent = [0.0, 0.0, 0.0]
    for counts, probability in types:
        for symbol in range(SYMBOL_COUNT):
            expected_opponent[symbol] += counts[symbol] * probability
    own = _counts(env.players[player_index].hand)
    after_duelists = [
        max(env.copies_per_symbol - own[symbol] - expected_opponent[symbol], 0.0)
        for symbol in range(SYMBOL_COUNT)
    ]
    reserve_count = max(env.table_seats - 2, 0) * 3
    available_total = sum(after_duelists)
    if reserve_count and available_total:
        reserve_fraction = min(reserve_count / available_total, 1.0)
        estimated_deck = [count * (1.0 - reserve_fraction) for count in after_duelists]
    else:
        estimated_deck = after_duelists
    deck_total = sum(estimated_deck)
    probabilities = tuple(
        count / deck_total if deck_total else 0.0 for count in estimated_deck
    )
    return types, (probabilities[0], probabilities[1], probabilities[2])


def _retained_value(
    hand: list[int],
    hp: int,
    opponent_types: list[tuple[tuple[int, int, int], float]],
    showdown_value: float,
    cache: dict[tuple[int, int, int], float],
) -> float:
    counts = _counts(hand)
    if len(hand) == 5 and max(counts) == 5:
        return hp + showdown_value
    if counts not in cache:
        rows = _ordered_sequences(counts)
        cache[counts] = _bayesian_maximin(rows, opponent_types)[1]
    return hp + cache[counts]


def _best_advanced_discards(
    hand: list[int],
    amount: int,
    hp: int,
    opponent_types: list[tuple[tuple[int, int, int], float]],
    showdown_value: float,
    cache: dict[tuple[int, int, int], float],
) -> tuple[float, list[list[int]]]:
    scored = [
        (_retained_value(remaining, hp, opponent_types, showdown_value, cache), discarded)
        for discarded, remaining in _discard_candidates(hand, amount)
    ]
    best = max(score for score, _ in scored)
    return best, [discarded for score, discarded in scored if abs(score - best) <= 1.0e-7]


def _advanced_draw_value(
    env: RPSCardEnv,
    player_index: int,
    rng: random.Random,
) -> tuple[bool, float, Optional[float]]:
    player = env.players[player_index]
    opponent_types, draw_probabilities = _advanced_model(env, player_index, rng)
    showdown_value = max(2, env.copies_per_symbol - 4) * 10
    cache: dict[tuple[int, int, int], float] = {}
    skip, _ = _best_advanced_discards(
        player.hand, player.required_discards, player.hp, opponent_types, showdown_value, cache
    )
    if player.hp <= 1 or not env.deck:
        return False, skip, None
    purchase = 0.0
    for symbol, probability in enumerate(draw_probabilities):
        if probability <= 0:
            continue
        value, _ = _best_advanced_discards(
            player.hand + [symbol],
            player.required_discards + 1,
            player.hp - 1,
            opponent_types,
            showdown_value,
            cache,
        )
        purchase += probability * value
    return purchase > skip + 1.0e-9, skip, purchase


def _advanced_discard_plan(env: RPSCardEnv, player_index: int, rng: random.Random) -> list[int]:
    player = env.players[player_index]
    opponent_types, _ = _advanced_model(env, player_index, rng)
    _, choices = _best_advanced_discards(
        player.hand,
        player.required_discards,
        player.hp,
        opponent_types,
        max(2, env.copies_per_symbol - 4) * 10,
        {},
    )
    return rng.choice(choices)


def _advanced_battle_action(
    env: RPSCardEnv,
    player_index: int,
    legal_mask: list[bool],
    rng: random.Random,
) -> int:
    player = env.players[player_index]
    opponent = 1 - player_index
    opponent_types = _sample_opponent_hands(env, player_index, rng)
    own_prefix = tuple(card for card in player.cards[: env.lane] if card is not None)
    opposing_prefix = tuple(
        card for card in env.players[opponent].cards[: env.lane] if card is not None
    )
    rows = _ordered_sequences(_counts(player.hand), own_prefix)
    conditioned_types: list[tuple[tuple[int, int, int], float]] = []
    for counts, probability in opponent_types:
        if _ordered_sequences(counts, opposing_prefix):
            conditioned_types.append((counts, probability))
    probability_total = sum(probability for _, probability in conditioned_types)
    conditioned_types = [
        (counts, probability / probability_total)
        for counts, probability in conditioned_types
    ] if probability_total else opponent_types
    policy, _ = _bayesian_maximin(rows, conditioned_types, column_prefix=opposing_prefix)
    symbol_weights = [(symbol, 0.0) for symbol in range(SYMBOL_COUNT)]
    accumulated = [0.0, 0.0, 0.0]
    for row, probability in zip(rows, policy):
        accumulated[row[env.lane]] += probability
    legal_symbols = {action // HEART_LEVELS for action in _legal_actions(legal_mask)}
    symbol_weights = [(symbol, accumulated[symbol]) for symbol in sorted(legal_symbols)]
    symbol = _weighted_choice(symbol_weights, rng)

    remaining = player.hp - sum(player.hearts)
    if env.lane == 2:
        hearts = remaining
    else:
        opposing = env.players[opponent]
        opponent_already_committed = opposing.cards[env.lane] is not None
        opposing_remaining = opposing.hp - sum(opposing.hearts[: env.lane])
        opposing_stake_options = (
            [opposing.hearts[env.lane]]
            if opponent_already_committed
            else list(range(opposing_remaining + 1))
        )
        symbol_probability = [0.0, 0.0, 0.0]
        for counts, probability in conditioned_types:
            available = list(counts)
            for card in opposing_prefix:
                available[card] -= 1
            total = sum(max(count, 0) for count in available)
            if total:
                for candidate in range(SYMBOL_COUNT):
                    symbol_probability[candidate] += probability * max(available[candidate], 0) / total
        preservation = 1.5 if player.hp <= opposing.hp * 0.5 else 1.0

        def heart_value(own_stake: int) -> float:
            return min(
                preservation * (remaining - own_stake)
                - (opposing_remaining - opposing_stake)
                + sum(
                    symbol_probability[opposing_symbol]
                    * (
                        preservation * (own_stake + max(opposing_stake - 1, 0))
                        if compare_symbols(symbol, opposing_symbol) > 0
                        else preservation * own_stake - opposing_stake
                        if compare_symbols(symbol, opposing_symbol) == 0
                        else -(opposing_stake + max(own_stake - 1, 0))
                    )
                    for opposing_symbol in range(SYMBOL_COUNT)
                )
                for opposing_stake in opposing_stake_options
            )

        legal_hearts = [
            action % HEART_LEVELS
            for action in _legal_actions(legal_mask)
            if action // HEART_LEVELS == symbol
        ]
        values = [(heart, heart_value(heart)) for heart in legal_hearts]
        best = max(value for _, value in values)
        optimal = [heart for heart, value in values if abs(value - best) <= 1.0e-7]
        hearts = rng.choice(optimal)
    return symbol * HEART_LEVELS + hearts


def advanced_action(
    env: RPSCardEnv,
    player_index: int,
    legal_mask: list[bool],
    rng: random.Random,
    state: ScriptedBotState,
) -> int:
    """Choose a public-information Bayesian/maximin training action."""
    if env.phase == "buy":
        return int(_advanced_draw_value(env, player_index, rng)[0])
    if env.phase == "discard":
        key = ("gto", player_index, env.round)
        if key not in state.discard_plans:
            state.discard_plans[key] = _advanced_discard_plan(env, player_index, rng)
        return state.discard_plans[key].pop(0)
    return _advanced_battle_action(env, player_index, legal_mask, rng)
