import json
from pathlib import Path
import unittest

from training.rps_env import RPSCardEnv, OBSERVATION_SIZE, ACTION_SIZE
from training.policy_schema import POLICY_SCHEMA


class PolicyContractTests(unittest.TestCase):
    def test_shared_observations(self):
        fixtures = json.loads((Path(__file__).resolve().parents[1]
            / "packages/game-core/test/fixtures/policy-observations.json").read_text())
        for case in fixtures:
            with self.subTest(case=case["name"]):
                env = RPSCardEnv(seed=1)
                env.phase, env.lane = case["phase"], case["lane"]
                env.attacker, env.actor_cursor = 0, 0
                env.copies_per_symbol = case["copiesPerSymbol"]
                env.deck = [0] * case["deckCount"]
                env.histories = [[], []]
                for index, player in enumerate(env.players):
                    player.hp = case["hp"][index]
                    player.hand = case["hands"][index]
                    player.cards = case["cards"][index]
                    player.hearts = case["hearts"][index]
                self.assertEqual(env.observe(0), case["observation"])
        self.assertEqual(OBSERVATION_SIZE, 90)
        self.assertEqual(ACTION_SIZE, 183)
        self.assertEqual(sum(item["size"] for item in POLICY_SCHEMA["features"]), OBSERVATION_SIZE)
