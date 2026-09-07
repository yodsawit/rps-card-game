from __future__ import annotations
import argparse
import json
from pathlib import Path
import torch
from training.model import MaskedActorCritic
from training.rps_env import ACTION_SIZE, OBSERVATION_SIZE

def save_checkpoint(
    path: Path,
    model: MaskedActorCritic,
    optimizer: torch.optim.Optimizer,
    update: int,
    arguments: argparse.Namespace,
) -> None:
    torch.save({
        "model_state": model.state_dict(),
        "optimizer_state": optimizer.state_dict(),
        "update": update,
        "observation_size": model.observation_size,
        "hidden_size": model.hidden_size,
        "action_schema": 2,
        "arguments": json.loads(json.dumps(vars(arguments), default=str)),
    }, path)


def export_onnx(model: MaskedActorCritic, output_path: Path, device: torch.device) -> None:
    model.eval()
    observation = torch.zeros((1, OBSERVATION_SIZE), dtype=torch.float32, device=device)
    legal_mask = torch.ones((1, ACTION_SIZE), dtype=torch.bool, device=device)
    try:
        torch.onnx.export(
            model,
            (observation, legal_mask),
            output_path,
            input_names=["observation", "legal_mask"],
            output_names=["policy_logits", "value"],
            dynamo=True,
        )
    except Exception as modern_error:
        print(f"Modern ONNX export failed ({modern_error}); trying the legacy exporter.")
        torch.onnx.export(
            model,
            (observation, legal_mask),
            output_path,
            input_names=["observation", "legal_mask"],
            output_names=["policy_logits", "value"],
            dynamic_axes={
                "observation": {0: "batch"},
                "legal_mask": {0: "batch"},
                "policy_logits": {0: "batch"},
                "value": {0: "batch"},
            },
            dynamo=False,
            opset_version=18,
        )
