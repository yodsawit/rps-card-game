import importlib.util
from io import BytesIO
from pathlib import Path
import unittest


class UnsafeCheckpoint:
    def __reduce__(self):
        return eval, ("1 + 1",)


@unittest.skipUnless(importlib.util.find_spec("torch"), "Checkpoint checks require PyTorch")
class CheckpointTests(unittest.TestCase):
    def test_restricted_loader_accepts_tensors_and_legacy_paths(self):
        import torch
        from training.checkpoints import load_checkpoint
        stream = BytesIO()
        torch.save({"weight": torch.tensor([1]), "path": Path("checkpoint")}, stream)
        stream.seek(0)
        loaded = load_checkpoint(stream, "cpu")
        self.assertEqual(loaded["weight"].item(), 1)
        self.assertEqual(str(loaded["path"]), "checkpoint")

    def test_restricted_loader_rejects_executable_pickle_globals(self):
        import torch
        from training.checkpoints import load_checkpoint
        stream = BytesIO()
        torch.save(UnsafeCheckpoint(), stream)
        stream.seek(0)
        with self.assertRaises(Exception):
            load_checkpoint(stream, "cpu")

    def test_action_head_migration_preserves_existing_heart_actions(self):
        import torch
        from training.checkpoints import load_policy_state
        from training.self_play import MaskedActorCritic
        model = MaskedActorCritic(hidden_size=8)
        old = model.state_dict()
        old["policy.weight"] = torch.arange(63 * 8, dtype=torch.float32).reshape(63, 8)
        old["policy.bias"] = torch.arange(63, dtype=torch.float32)
        self.assertTrue(load_policy_state(model, old))
        for symbol in range(3):
            self.assertTrue(torch.equal(model.policy.bias[symbol * 61:symbol * 61 + 21], old["policy.bias"][symbol * 21:symbol * 21 + 21]))
        self.assertEqual(model.policy.out_features, 183)
