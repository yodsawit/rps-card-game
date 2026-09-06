"""A fast, dependency-free two-duelist training environment.

The environment mirrors the authoritative TypeScript rules at the decision
level. Card instances are represented by symbols because cards of the same
symbol are strategically interchangeable. Actions are sequential and expose
only information that is public to the acting player.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import random
from typing import Optional, Sequence


SYMBOLS = ("rock", "paper", "scissors")
SYMBOL_COUNT = len(SYMBOLS)
MIN_TABLE_SEATS = 2
MAX_TABLE_SEATS = 6
COPIES_PER_SYMBOL = 6
STARTING_HP = 10
MAX_TOTAL_HP = STARTING_HP * 2
MAX_HAND_SIZE = 5
STARTING_HAND_SIZE = 3
TRAINING_SCENARIOS = ("three_kind", "four_kind", "five_kind", "low_hp_draw", "max_hand")
HEART_LEVELS = MAX_TOTAL_HP + 1
ACTION_SIZE = SYMBOL_COUNT * HEART_LEVELS
OBSERVATION_SIZE = 90


@dataclass
class PublicRoundMemory:
    hand_count: int
    symbols: tuple[int, int, int]
    hearts: tuple[int, int, int]
    drawn_count: int = 0
    discarded_count: int = 0
    bonus_draw: bool = False
    paid_draw: bool = False


@dataclass
class PlayerState:
    hp: int = STARTING_HP
    hand: list[int] = field(default_factory=list)
    cards: list[Optional[int]] = field(default_factory=lambda: [None, None, None])
    hearts: list[int] = field(default_factory=lambda: [0, 0, 0])
    no_loss_bonus: bool = False
    required_discards: int = 0
    drawn_count: int = 0
    discarded_count: int = 0
    paid_draw: bool = False
    recent_loss_ratio: float = 0.0
    discard_choices: list[int] = field(default_factory=list)


def compare_symbols(left: int, right: int) -> int:
    """Return 1 for a left win, -1 for a left loss, and 0 for a draw."""
    if left == right:
        return 0
    if (left == 0 and right == 2) or (left == 2 and right == 1) or (left == 1 and right == 0):
        return 1
    return -1


def resolve_battle(
    cards: Sequence[Sequence[int]],
    hearts: Sequence[Sequence[int]],
) -> tuple[tuple[int, int], tuple[tuple[int, int, int], tuple[int, int, int]]]:
    """Resolve three committed lanes using RPS, transfer loss, and triple rules."""
    if len(cards) != 2 or any(len(side) != 3 for side in cards):
        raise ValueError("A battle requires three cards for both players.")
    if len(hearts) != 2 or any(len(side) != 3 for side in hearts):
        raise ValueError("A battle requires three HP stakes for both players.")
    triples = [len(set(cards[player])) == 1 for player in range(2)]
    totals = [0, 0]
    results = [[], []]
    for lane in range(3):
        result = compare_symbols(cards[0][lane], cards[1][lane])
        if result == 0 and triples[0] != triples[1]:
            result = 1 if triples[0] else -1
        results[0].append(result)
        results[1].append(-result)
        left_stake = hearts[0][lane]
        right_stake = hearts[1][lane]
        if result >= 0:
            totals[0] += left_stake if result == 0 else left_stake + max(right_stake - 1, 0)
        if result <= 0:
            totals[1] += right_stake if result == 0 else right_stake + max(left_stake - 1, 0)
    return (totals[0], totals[1]), (
        (results[0][0], results[0][1], results[0][2]),
        (results[1][0], results[1][1], results[1][2]),
    )


class RPSCardEnv:
    """Two-player, alternating-action environment for self-play.

    Decision phases are ``battle``, ``buy``, and ``discard``. During battle,
    the action encodes ``symbol * HEART_LEVELS + hearts``. Buy uses actions 0
    and 1, and discard uses actions 0, 1, and 2 for the three symbols. Always
    apply :meth:`legal_action_mask` before sampling an action.
    """

    agents = ("player_0", "player_1")

    def __init__(
        self,
        seed: Optional[int] = None,
        max_rounds: int = 100,
        table_seats: int = 2,
        scenario: Optional[str] = None,
    ):
        if table_seats < MIN_TABLE_SEATS or table_seats > MAX_TABLE_SEATS:
            raise ValueError(
                f"table_seats must be between {MIN_TABLE_SEATS} and {MAX_TABLE_SEATS}."
            )
        if scenario is not None and scenario not in TRAINING_SCENARIOS:
            raise ValueError(f"Unknown training scenario: {scenario}.")
        self.max_rounds = max_rounds
        self.table_seats = table_seats
        self.copies_per_symbol = table_seats + 4
        self.scenario = scenario
        self.rng = random.Random(seed)
        self.seed_value = seed
        self.players = [PlayerState(), PlayerState()]
        self.histories: list[list[PublicRoundMemory]] = [[], []]
        self.deck: list[int] = []
        self.reserve_hands: list[list[int]] = []
        self.returned_cards: list[int] = []
        self.phase = "battle"
        self.round = 1
        self.attacker = 0
        self.current_player = 0
        self.lane = 0
        self.actor_cursor = 0
        self.terminated = False
        self.winner: Optional[int] = None
        self.reason: Optional[str] = None
        self.step_count = 0
        self.reset(seed)

    @property
    def agent_selection(self) -> str:
        return self.agents[self.current_player]

    def reset(self, seed: Optional[int] = None) -> tuple[list[float], list[bool]]:
        if seed is not None:
            self.seed_value = seed
            self.rng.seed(seed)
        self.deck = [
            symbol
            for symbol in range(SYMBOL_COUNT)
            for _ in range(self.copies_per_symbol)
        ]
        self.rng.shuffle(self.deck)
        self.players = [PlayerState(), PlayerState()]
        self.histories = [[], []]
        self.returned_cards = []
        self.reserve_hands = [[] for _ in range(self.table_seats - 2)]
        self.phase = "battle"
        self.round = 1
        self.attacker = 0
        self.current_player = 0
        self.lane = 0
        self.actor_cursor = 0
        self.terminated = False
        self.winner = None
        self.reason = None
        self.step_count = 0
        for _ in range(STARTING_HAND_SIZE):
            for player in self.players:
                player.hand.append(self._draw_one())
            for reserve_hand in self.reserve_hands:
                reserve_hand.append(self._draw_one())
        if self.scenario:
            self._apply_training_scenario(self.scenario)
        return self.observe(self.current_player), self.legal_action_mask()

    def _apply_training_scenario(self, scenario: str) -> None:
        """Start at a legal post-mandatory-draw state for curriculum training."""
        scenarios: dict[str, tuple[list[list[int]], list[int]]] = {
            "three_kind": ([[0, 0, 0, 1], [1, 1, 1, 2]], [STARTING_HP, STARTING_HP]),
            "four_kind": ([[0, 0, 0, 0, 2], [1, 1, 1, 1, 0]], [STARTING_HP, STARTING_HP]),
            "five_kind": ([[0, 0, 0, 0, 0, 2], [1, 1, 1, 1, 1, 0]], [STARTING_HP, STARTING_HP]),
            "low_hp_draw": ([[0, 0, 0, 0, 2], [1, 1, 1, 1, 0]], [2, 2]),
            "max_hand": ([[0, 0, 1, 1, 2, 2], [0, 1, 1, 2, 2, 0]], [STARTING_HP, STARTING_HP]),
        }
        hands, hit_points = scenarios[scenario]
        self.deck = [
            symbol
            for symbol in range(SYMBOL_COUNT)
            for _ in range(self.copies_per_symbol)
        ]
        self.rng.shuffle(self.deck)
        for hand in hands:
            for symbol in hand:
                self.deck.remove(symbol)
        self.reserve_hands = [[] for _ in range(self.table_seats - 2)]
        for _ in range(STARTING_HAND_SIZE):
            for reserve_hand in self.reserve_hands:
                reserve_hand.append(self._draw_one())
        self.players = [PlayerState(), PlayerState()]
        self.histories = [[], []]
        for player_index, player in enumerate(self.players):
            player.hand = hands[player_index][:]
            player.hp = hit_points[player_index]
            player.required_discards = max(len(player.hand) - MAX_HAND_SIZE, 1)
            player.drawn_count = 1
            self.histories[player_index].append(PublicRoundMemory(
                hand_count=max(len(player.hand) - 1, STARTING_HAND_SIZE),
                symbols=(player.hand[0], player.hand[1], player.hand[2]),
                hearts=(0, 0, 0),
            ))
        self.phase = "buy"
        self.current_player = self.attacker
        self.actor_cursor = 0
        self.lane = 0

    def _draw_one(self) -> int:
        if not self.deck:
            raise RuntimeError("The mutual deck does not contain enough cards.")
        return self.deck.pop()

    def _duelist_order(self) -> tuple[int, int]:
        return self.attacker, 1 - self.attacker

    def _remaining_hp(self, player: int) -> int:
        return self.players[player].hp - sum(self.players[player].hearts)

    def legal_action_mask(self) -> list[bool]:
        mask = [False] * ACTION_SIZE
        if self.terminated:
            return mask
        player = self.players[self.current_player]
        if self.phase == "battle":
            committed = [0, 0, 0]
            for card in player.cards:
                if card is not None:
                    committed[card] += 1
            available = [player.hand.count(symbol) - committed[symbol] for symbol in range(SYMBOL_COUNT)]
            remaining = self._remaining_hp(self.current_player)
            legal_hearts = range(remaining + 1) if self.lane < 2 else (remaining,)
            for symbol in range(SYMBOL_COUNT):
                if available[symbol] <= 0:
                    continue
                for hearts in legal_hearts:
                    mask[symbol * HEART_LEVELS + hearts] = True
        elif self.phase == "buy":
            mask[0] = True
            mask[1] = player.hp > 1 and bool(self.deck)
        elif self.phase == "discard":
            for symbol in range(SYMBOL_COUNT):
                mask[symbol] = player.hand.count(symbol) > player.discard_choices.count(symbol)
        return mask

    def step(self, action: int) -> None:
        if self.terminated:
            raise RuntimeError("The episode has already ended.")
        if action < 0 or action >= ACTION_SIZE or not self.legal_action_mask()[action]:
            raise ValueError(f"Illegal action {action} during {self.phase}.")
        self.step_count += 1
        if self.phase == "battle":
            self._step_battle(action)
        elif self.phase == "buy":
            self._step_buy(action)
        elif self.phase == "discard":
            self._step_discard(action)
        else:
            raise RuntimeError(f"Unknown phase: {self.phase}")

    def _step_battle(self, action: int) -> None:
        player_index = self.current_player
        player = self.players[player_index]
        symbol = action // HEART_LEVELS
        hearts = action % HEART_LEVELS
        if self.lane == 2:
            hearts = self._remaining_hp(player_index)
        player.cards[self.lane] = symbol
        player.hearts[self.lane] = hearts
        order = self._duelist_order()
        if self.actor_cursor == 0:
            self.actor_cursor = 1
            self.current_player = order[1]
            return
        self.actor_cursor = 0
        if self.lane < 2:
            self.lane += 1
            self.current_player = order[0]
            return
        self._finish_battle()

    def _finish_battle(self) -> None:
        cards = [
            [int(card) for card in self.players[player].cards]
            for player in range(2)
        ]
        hearts = [self.players[player].hearts[:] for player in range(2)]
        totals, results = resolve_battle(cards, hearts)
        for player in range(2):
            state = self.players[player]
            hp_before_battle = state.hp
            state.hp = totals[player]
            state.recent_loss_ratio = (
                max(hp_before_battle - totals[player], 0) / hp_before_battle
                if hp_before_battle > 0
                else 0.0
            )
            state.no_loss_bonus = all(result >= 0 for result in results[player])
            self.histories[player].append(PublicRoundMemory(
                hand_count=len(state.hand),
                symbols=(cards[player][0], cards[player][1], cards[player][2]),
                hearts=(hearts[player][0], hearts[player][1], hearts[player][2]),
                bonus_draw=state.no_loss_bonus,
            ))
            self.histories[player] = self.histories[player][-2:]
        if totals[0] == 0 and totals[1] == 0:
            self._finish(None, "hp")
            return
        if totals[0] == 0:
            self._finish(1, "hp")
            return
        if totals[1] == 0:
            self._finish(0, "hp")
            return
        self._start_draw_phase()

    def _start_draw_phase(self) -> None:
        for player_index in self._duelist_order():
            player = self.players[player_index]
            original_size = len(player.hand)
            draw_count = 2 if player.no_loss_bonus else 1
            for _ in range(draw_count):
                player.hand.append(self._draw_one())
            player.required_discards = 2 if player.no_loss_bonus and original_size >= MAX_HAND_SIZE else 1
            player.drawn_count = draw_count
            player.discarded_count = 0
            player.paid_draw = False
            player.cards = [None, None, None]
            player.hearts = [0, 0, 0]
        self.phase = "buy"
        self.actor_cursor = 0
        self.current_player = self._duelist_order()[0]

    def _step_buy(self, action: int) -> None:
        player = self.players[self.current_player]
        if action == 1:
            player.hp -= 1
            player.hand.append(self._draw_one())
            player.required_discards += 1
            player.drawn_count += 1
            player.paid_draw = True
        order = self._duelist_order()
        if self.actor_cursor == 0:
            self.actor_cursor = 1
            self.current_player = order[1]
            return
        self.phase = "discard"
        self.actor_cursor = 0
        self.current_player = order[0]

    def _step_discard(self, action: int) -> None:
        player = self.players[self.current_player]
        player.discard_choices.append(action)
        player.required_discards -= 1
        player.discarded_count += 1
        if player.required_discards > 0:
            return
        order = self._duelist_order()
        if self.actor_cursor == 0:
            self.actor_cursor = 1
            self.current_player = order[1]
            return
        self._finish_discards()

    def _finish_discards(self) -> None:
        for player_index, player in enumerate(self.players):
            for symbol in player.discard_choices:
                player.hand.remove(symbol)
                self.returned_cards.append(symbol)
            memory = self.histories[player_index][-1]
            memory.drawn_count = player.drawn_count
            memory.discarded_count = player.discarded_count
            memory.paid_draw = player.paid_draw
        showdown = [self._five_of_a_kind(player) for player in self.players]
        self.deck.extend(self.returned_cards)
        self.returned_cards = []
        self.rng.shuffle(self.deck)
        if showdown[0] is not None or showdown[1] is not None:
            if showdown[0] is None:
                self._finish(1, "showdown")
            elif showdown[1] is None:
                self._finish(0, "showdown")
            else:
                result = compare_symbols(showdown[0], showdown[1])
                self._finish(0 if result > 0 else 1 if result < 0 else None, "showdown")
            return
        self.round += 1
        if self.round > self.max_rounds:
            self._finish(None, "truncation")
            return
        self.attacker = 1 - self.attacker
        self.phase = "battle"
        self.lane = 0
        self.actor_cursor = 0
        self.current_player = self.attacker
        for player in self.players:
            player.cards = [None, None, None]
            player.hearts = [0, 0, 0]
            player.no_loss_bonus = False
            player.required_discards = 0
            player.drawn_count = 0
            player.discarded_count = 0
            player.paid_draw = False
            player.discard_choices = []

    @staticmethod
    def _five_of_a_kind(player: PlayerState) -> Optional[int]:
        if len(player.hand) == 5 and len(set(player.hand)) == 1:
            return player.hand[0]
        return None

    def _finish(self, winner: Optional[int], reason: str) -> None:
        self.terminated = True
        self.winner = winner
        self.reason = reason

    def terminal_rewards(self) -> tuple[float, float]:
        if not self.terminated or self.winner is None:
            return 0.0, 0.0
        return (1.0, -1.0) if self.winner == 0 else (-1.0, 1.0)

    @staticmethod
    def _symbol_one_hot(symbol: Optional[int]) -> list[float]:
        values = [0.0, 0.0, 0.0, 0.0]
        values[0 if symbol is None else symbol + 1] = 1.0
        return values

    def _visible_symbol(self, perspective: int, owner: int, lane: int) -> Optional[int]:
        card = self.players[owner].cards[lane]
        if owner == perspective:
            return card
        if self.phase != "battle" or lane < self.lane:
            return card
        return None

    def _encode_memory(self, memory: Optional[PublicRoundMemory]) -> list[float]:
        if memory is None:
            return [0.0] * 21
        encoded = [1.0, memory.hand_count / 8.0]
        for symbol in memory.symbols:
            encoded.extend(self._symbol_one_hot(symbol))
        encoded.extend(hearts / MAX_TOTAL_HP for hearts in memory.hearts)
        encoded.extend((
            memory.drawn_count / 3.0,
            memory.discarded_count / 3.0,
            float(memory.bonus_draw),
            float(memory.paid_draw),
        ))
        return encoded

    def observe(self, player_index: Optional[int] = None) -> list[float]:
        perspective = self.current_player if player_index is None else player_index
        opponent = 1 - perspective
        player = self.players[perspective]
        opposing = self.players[opponent]
        phase_index = self.lane if self.phase == "battle" else 3 if self.phase == "buy" else 4
        observation = [float(index == phase_index) for index in range(5)]
        observation.extend((player.hp / MAX_TOTAL_HP, opposing.hp / MAX_TOTAL_HP))
        observation.extend(
            (player.hand.count(symbol) - player.discard_choices.count(symbol)) / 8.0
            for symbol in range(SYMBOL_COUNT)
        )
        observation.extend((
            len(opposing.hand) / 8.0,
            len(self.deck) / (SYMBOL_COUNT * self.copies_per_symbol),
            float(perspective == self.attacker),
            float(self.phase == "battle" and self.actor_cursor == 0),
            float(self.phase == "battle" and opposing.cards[self.lane] is not None),
            (opposing.hearts[self.lane] / MAX_TOTAL_HP) if self.phase == "battle" else 0.0,
            self._remaining_hp(perspective) / MAX_TOTAL_HP,
            self._remaining_hp(opponent) / MAX_TOTAL_HP,
        ))
        for lane in range(3):
            observation.extend(self._symbol_one_hot(self._visible_symbol(perspective, perspective, lane)))
            observation.append(player.hearts[lane] / MAX_TOTAL_HP)
            observation.extend(self._symbol_one_hot(self._visible_symbol(perspective, opponent, lane)))
            observation.append(opposing.hearts[lane] / MAX_TOTAL_HP)
        memories = self.histories[opponent][-2:]
        padded: list[Optional[PublicRoundMemory]] = [None] * (2 - len(memories)) + list(memories)
        for memory in padded:
            observation.extend(self._encode_memory(memory))
        if len(observation) != OBSERVATION_SIZE:
            raise AssertionError(f"Expected {OBSERVATION_SIZE} observations, got {len(observation)}.")
        return observation

    def public_summary(self) -> dict[str, object]:
        return {
            "round": self.round,
            "phase": self.phase,
            "current_player": self.current_player,
            "attacker": self.attacker,
            "hp": [player.hp for player in self.players],
            "hand_counts": [len(player.hand) for player in self.players],
            "deck_count": len(self.deck),
            "table_seats": self.table_seats,
            "copies_per_symbol": self.copies_per_symbol,
            "terminated": self.terminated,
            "winner": self.winner,
            "reason": self.reason,
        }
