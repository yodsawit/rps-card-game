from __future__ import annotations

import random
import unittest

from training.rps_env import RPSCardEnv
from training.scripted_bots import ScriptedBotState, advanced_action, arc_action


class ScriptedBotTests(unittest.TestCase):
    def test_arc_always_buys_with_four_of_a_kind_when_legal(self) -> None:
        for scenario in ("four_kind", "five_kind", "low_hp_draw"):
            env = RPSCardEnv(seed=4, scenario=scenario)
            action = arc_action(
                env,
                env.current_player,
                env.legal_action_mask(),
                random.Random(99),
                ScriptedBotState(),
            )
            self.assertEqual(action, 1)

    def test_advanced_skips_paid_draw_when_five_kind_is_already_secured(self) -> None:
        env = RPSCardEnv(seed=9, scenario="five_kind")
        action = advanced_action(
            env,
            env.current_player,
            env.legal_action_mask(),
            random.Random(10),
            ScriptedBotState(),
        )
        self.assertEqual(action, 0)

    def test_scripted_bots_complete_all_curriculum_states(self) -> None:
        for scenario in ("three_kind", "four_kind", "five_kind", "low_hp_draw", "max_hand"):
            env = RPSCardEnv(seed=17, table_seats=6, scenario=scenario, max_rounds=20)
            rng = random.Random(18)
            states = [ScriptedBotState(), ScriptedBotState()]
            while not env.terminated:
                player = env.current_player
                action = (
                    arc_action(env, player, env.legal_action_mask(), rng, states[player])
                    if player == 0
                    else advanced_action(env, player, env.legal_action_mask(), rng, states[player])
                )
                env.step(action)
            self.assertIn(env.reason, {"hp", "showdown", "truncation"})


if __name__ == "__main__":
    unittest.main()
