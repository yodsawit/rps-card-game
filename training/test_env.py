from __future__ import annotations

import random
import unittest

from training.rps_env import (
    ACTION_SIZE,
    COPIES_PER_SYMBOL,
    HEART_LEVELS,
    OBSERVATION_SIZE,
    RPSCardEnv,
    SYMBOL_COUNT,
    resolve_battle,
)


def battle_action(symbol: int, hearts: int) -> int:
    return symbol * HEART_LEVELS + hearts


class RPSCardEnvironmentTests(unittest.TestCase):
    def test_reset_has_the_authoritative_two_player_deck(self) -> None:
        env = RPSCardEnv(seed=3)
        self.assertEqual(len(env.deck), SYMBOL_COUNT * COPIES_PER_SYMBOL - 6)
        self.assertEqual([len(player.hand) for player in env.players], [3, 3])
        self.assertEqual(len(env.observe()), OBSERVATION_SIZE)
        self.assertEqual(len(env.legal_action_mask()), ACTION_SIZE)
        self.assertTrue(any(env.legal_action_mask()))

    def test_triple_overrides_only_draw_lanes(self) -> None:
        totals, results = resolve_battle(
            ((0, 0, 0), (0, 1, 2)),
            ((3, 3, 4), (3, 3, 4)),
        )
        self.assertEqual(results[0], (1, -1, 1))
        self.assertEqual(results[1], (-1, 1, -1))
        self.assertEqual(totals, (12, 5))

    def test_winner_receives_loser_stake_minus_one(self) -> None:
        totals, results = resolve_battle(
            ((1, 0, 2), (0, 0, 2)),
            ((3, 2, 5), (4, 2, 4)),
        )
        self.assertEqual(results[0], (1, 0, 0))
        self.assertEqual(totals, (13, 6))

    def test_hidden_card_becomes_public_after_both_players_commit(self) -> None:
        env = RPSCardEnv(seed=8)
        attacker = env.current_player
        symbol = env.players[attacker].hand[0]
        env.step(battle_action(symbol, 2))
        defender = env.current_player
        self.assertIsNone(env._visible_symbol(defender, attacker, 0))
        self.assertEqual(env.players[attacker].hearts[0], 2)
        defender_symbol = env.players[defender].hand[0]
        env.step(battle_action(defender_symbol, 1))
        self.assertEqual(env.lane, 1)
        self.assertEqual(env._visible_symbol(env.current_player, attacker, 0), symbol)

    def test_final_lane_receives_every_uncommitted_heart(self) -> None:
        env = RPSCardEnv(seed=11)
        env.players[0].hand = [0, 1, 2]
        env.players[1].hand = [0, 1, 2]
        for lane, hearts in enumerate((2, 3, 5)):
            env.step(battle_action(lane, hearts))
            env.step(battle_action(lane, hearts))
        self.assertFalse(env.terminated)
        self.assertEqual(env.histories[0][-1].hearts, (2, 3, 5))
        self.assertEqual(env.histories[1][-1].hearts, (2, 3, 5))
        self.assertEqual(env.phase, "buy")

    def test_paid_draw_costs_one_hp_and_one_more_discard(self) -> None:
        env = RPSCardEnv(seed=13)
        env.players[0].hand = [0, 1, 2]
        env.players[1].hand = [0, 1, 2]
        for lane, hearts in enumerate((3, 3, 4)):
            env.step(battle_action(lane, hearts))
            env.step(battle_action(lane, hearts))
        player = env.current_player
        hp_before = env.players[player].hp
        deck_before = len(env.deck)
        required_before = env.players[player].required_discards
        env.step(1)
        self.assertEqual(env.players[player].hp, hp_before - 1)
        self.assertEqual(len(env.deck), deck_before - 1)
        self.assertEqual(env.players[player].required_discards, required_before + 1)

    def test_random_legal_play_preserves_cards_and_terminates(self) -> None:
        chooser = random.Random(21)
        for seed in range(20):
            env = RPSCardEnv(seed=seed, max_rounds=30)
            while not env.terminated:
                legal = [index for index, allowed in enumerate(env.legal_action_mask()) if allowed]
                self.assertTrue(legal)
                env.step(chooser.choice(legal))
                card_total = len(env.deck) + len(env.returned_cards) + sum(len(player.hand) for player in env.players)
                self.assertEqual(card_total, SYMBOL_COUNT * COPIES_PER_SYMBOL)
                self.assertLessEqual(sum(player.hp for player in env.players), 20)
                self.assertGreaterEqual(min(player.hp for player in env.players), 0)
            self.assertIn(env.reason, {"hp", "showdown", "truncation"})


if __name__ == "__main__":
    unittest.main()
