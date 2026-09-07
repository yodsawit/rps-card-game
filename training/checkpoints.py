"""Restricted checkpoint loading and explicit v1 -> v2 action-head migration."""
from pathlib import PurePath, PurePosixPath, PureWindowsPath
import torch


def load_checkpoint(source, device):
    # Older checkpoints contain argparse paths. Only inert path constructors
    # are allowed; arbitrary pickle globals and custom unpicklers are rejected.
    allowed = [(PurePath, "pathlib.Path"), (PurePosixPath, "pathlib.PosixPath"),
               (PureWindowsPath, "pathlib.WindowsPath"),
               (PurePath, "pathlib._local.Path"),
               (PurePosixPath, "pathlib._local.PosixPath"),
               (PureWindowsPath, "pathlib._local.WindowsPath")]
    with torch.serialization.safe_globals(allowed):
        return torch.load(source, map_location=device, weights_only=True)


def load_policy_state(model, state):
    """Preserve trained 0..20 stakes; seed new stakes from the old maximum.

    New actions start with low probability until trained. Forced final stakes
    remain legal at every HP. Promotion must still pass the production gate.
    """
    target = model.state_dict()
    old_size = state["policy.bias"].shape[0]
    new_size = target["policy.bias"].shape[0]
    migrated = old_size != new_size
    if migrated:
        if (old_size, new_size) != (63, 183):
            raise ValueError(f"Unsupported action schema migration: {old_size} -> {new_size}")
        state = dict(state)
        for key in ("policy.weight", "policy.bias"):
            expanded = target[key].clone()
            for symbol in range(3):
                expanded[symbol * 61:symbol * 61 + 21] = state[key][symbol * 21:symbol * 21 + 21]
                expanded[symbol * 61 + 21:(symbol + 1) * 61] = state[key][symbol * 21 + 20]
                if key == "policy.bias":
                    expanded[symbol * 61 + 21:(symbol + 1) * 61] -= 10
            state[key] = expanded
    model.load_state_dict(state)
    return migrated
