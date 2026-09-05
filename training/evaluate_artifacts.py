"""Compare trained checkpoints, test the winner against TypeScript bots, and export it.

The evaluator accepts either a Colab artifact ZIP or an extracted artifact
directory. All policy comparisons use the same environment and policy seeds
for both checkpoints, alternate seats, and sample the learned mixed policy.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import pathlib
import pickle
import subprocess
import sys
from typing import Any
import zipfile

import numpy as np
import onnx
import onnxruntime as ort
import torch

from training.self_play import MaskedActorCritic, export_onnx, play_episode


ROOT = Path(__file__).resolve().parents[1]


@dataclass
class MatchRecord:
    episodes: int
    wins: int
    losses: int
    draws: int
    average_rounds: float
    seat_0: dict[str, int]
    seat_1: dict[str, int]

    @property
    def win_rate(self) -> float:
        return self.wins / self.episodes

    @property
    def non_loss_rate(self) -> float:
        return (self.wins + self.draws) / self.episodes

    def to_dict(self) -> dict[str, Any]:
        return asdict(self) | {
            "win_rate": self.win_rate,
            "non_loss_rate": self.non_loss_rate,
        }


class ArtifactSource:
    def __init__(self, path: Path):
        self.path = path
        self.archive = zipfile.ZipFile(path) if path.is_file() else None

    def close(self) -> None:
        if self.archive:
            self.archive.close()

    def bytes(self, name: str) -> bytes:
        if self.archive:
            return self.archive.read(name)
        return (self.path / name).read_bytes()

    def json(self, name: str) -> dict[str, Any]:
        return json.loads(self.bytes(name).decode("utf-8"))


class CompatibleUnpickler(pickle.Unpickler):
    """Read Python 3.13 pathlib checkpoints on Python 3.12 and earlier."""

    def find_class(self, module: str, name: str) -> Any:
        if module == "pathlib._local":
            replacements = {
                "Path": pathlib.PurePath,
                "PosixPath": pathlib.PurePosixPath,
                "WindowsPath": pathlib.PureWindowsPath,
            }
            if name in replacements:
                return replacements[name]
        return super().find_class(module, name)


class CompatiblePickleModule:
    __name__ = pickle.__name__
    Unpickler = CompatibleUnpickler
    Pickler = pickle.Pickler
    load = staticmethod(pickle.load)
    loads = staticmethod(pickle.loads)
    dump = staticmethod(pickle.dump)
    dumps = staticmethod(pickle.dumps)


def load_model(checkpoint_bytes: bytes, device: torch.device) -> tuple[MaskedActorCritic, dict[str, Any]]:
    checkpoint = torch.load(
        BytesIO(checkpoint_bytes),
        map_location=device,
        weights_only=False,
        pickle_module=CompatiblePickleModule,
    )
    model = MaskedActorCritic(
        observation_size=int(checkpoint["observation_size"]),
        hidden_size=int(checkpoint["hidden_size"]),
    ).to(device)
    model.load_state_dict(checkpoint["model_state"])
    model.eval()
    return model, checkpoint


def empty_seats() -> list[dict[str, int]]:
    return [{"wins": 0, "losses": 0, "draws": 0}, {"wins": 0, "losses": 0, "draws": 0}]


def record_result(
    seats: list[dict[str, int]], learner_seat: int, winner: int | None
) -> tuple[int, int, int]:
    if winner is None:
        seats[learner_seat]["draws"] += 1
        return 0, 0, 1
    if winner == learner_seat:
        seats[learner_seat]["wins"] += 1
        return 1, 0, 0
    seats[learner_seat]["losses"] += 1
    return 0, 1, 0


def evaluate_python_heuristic(
    model: MaskedActorCritic,
    device: torch.device,
    episodes: int,
    environment_seed: int,
    policy_seed: int,
) -> MatchRecord:
    wins = losses = draws = rounds = 0
    seats = empty_seats()
    for index in range(episodes):
        learner_seat = index % 2
        torch.manual_seed(policy_seed + index)
        result = play_episode(
            model,
            device,
            environment_seed + index,
            mode="heuristic",
            learner_seat=learner_seat,
            collect=False,
        )
        result_counts = record_result(seats, learner_seat, result.winner)
        wins += result_counts[0]
        losses += result_counts[1]
        draws += result_counts[2]
        rounds += result.rounds
    return MatchRecord(episodes, wins, losses, draws, rounds / episodes, seats[0], seats[1])


def evaluate_head_to_head(
    left: MaskedActorCritic,
    right: MaskedActorCritic,
    device: torch.device,
    episodes: int,
    environment_seed: int,
    policy_seed: int,
) -> MatchRecord:
    wins = losses = draws = rounds = 0
    seats = empty_seats()
    for index in range(episodes):
        left_seat = index % 2
        torch.manual_seed(policy_seed + index)
        result = play_episode(
            left,
            device,
            environment_seed + index,
            mode="league",
            learner_seat=left_seat,
            opponent_model=right,
            collect=False,
        )
        result_counts = record_result(seats, left_seat, result.winner)
        wins += result_counts[0]
        losses += result_counts[1]
        draws += result_counts[2]
        rounds += result.rounds
    return MatchRecord(episodes, wins, losses, draws, rounds / episodes, seats[0], seats[1])


def validate_onnx(model: MaskedActorCritic, path: Path) -> dict[str, Any]:
    rng = np.random.default_rng(20260906)
    observation = rng.normal(size=(1, 90)).astype(np.float32)
    legal_mask = rng.random(size=(1, 63)) > 0.2
    legal_mask[0, 0] = True
    with torch.no_grad():
        expected_logits, expected_value = model(
            torch.from_numpy(observation), torch.from_numpy(legal_mask)
        )
    inference = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    actual_logits, actual_value = inference.run(
        None,
        {"observation": observation, "legal_mask": legal_mask},
    )
    logits_error = float(np.max(np.abs(actual_logits - expected_logits.numpy())))
    value_error = float(np.max(np.abs(actual_value - expected_value.numpy())))
    if logits_error > 1.0e-4 or value_error > 1.0e-4:
        raise RuntimeError(
            f"ONNX parity failed: logits error {logits_error}, value error {value_error}."
        )
    return {
        "providers": inference.get_providers(),
        "inputs": {item.name: item.shape for item in inference.get_inputs()},
        "outputs": {item.name: item.shape for item in inference.get_outputs()},
        "maximum_logits_error": logits_error,
        "maximum_value_error": value_error,
        "external_data_present": path.with_suffix(path.suffix + ".data").is_file(),
    }


def export_json_weights(model: MaskedActorCritic, path: Path) -> None:
    state = model.state_dict()
    payload = {
        "schemaVersion": 1,
        "observationSize": model.observation_size,
        "hiddenSize": model.hidden_size,
        "actionSize": 63,
        "layers": {
            "body0Weight": state["body.0.weight"].cpu().tolist(),
            "body0Bias": state["body.0.bias"].cpu().tolist(),
            "body2Weight": state["body.2.weight"].cpu().tolist(),
            "body2Bias": state["body.2.bias"].cpu().tolist(),
            "policyWeight": state["policy.weight"].cpu().tolist(),
            "policyBias": state["policy.bias"].cpu().tolist(),
        },
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def evaluate_authoritative_typescript_bots(episodes: int, seed: int, output_path: Path) -> dict[str, Any]:
    executable = ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
    completed = subprocess.run(
        [
            str(executable),
            str(ROOT / "training" / "evaluate_server_bots.ts"),
            "--episodes",
            str(episodes),
            "--seed",
            str(seed),
            "--output",
            str(output_path),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(completed.stdout)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--episodes", type=int, default=2_000)
    parser.add_argument("--typescript-episodes", type=int, default=200)
    parser.add_argument("--seed", type=int, default=71_000_000)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "apps" / "server" / "models")
    return parser.parse_args()


def main() -> None:
    args = parse_arguments()
    if args.episodes < 2_000:
        raise ValueError("Matched checkpoint evaluation requires at least 2,000 episodes.")
    if args.typescript_episodes < 2:
        raise ValueError("TypeScript evaluation requires at least two episodes for both seat orders.")
    torch.set_num_threads(max(1, min(torch.get_num_threads(), 4)))
    device = torch.device("cpu")
    source = ArtifactSource(args.artifacts)
    try:
        checkpoint_bytes = {name: source.bytes(name) for name in ("best.pt", "final.pt")}
        models_and_checkpoints = {
            name: load_model(data, device) for name, data in checkpoint_bytes.items()
        }
        source_spec = source.json("model-spec.json")
    finally:
        source.close()

    matched: dict[str, dict[str, Any]] = {}
    for name, (model, checkpoint) in models_and_checkpoints.items():
        print(f"Evaluating {name} (update {checkpoint['update']}) for {args.episodes} matched games...", flush=True)
        matched[name] = evaluate_python_heuristic(
            model, device, args.episodes, args.seed, args.seed + 10_000_000
        ).to_dict()

    print(f"Running {args.episodes} best-vs-final games...", flush=True)
    head_to_head = evaluate_head_to_head(
        models_and_checkpoints["best.pt"][0],
        models_and_checkpoints["final.pt"][0],
        device,
        args.episodes,
        args.seed + 20_000_000,
        args.seed + 30_000_000,
    ).to_dict()

    selected_name = max(
        matched,
        key=lambda name: (
            matched[name]["win_rate"],
            matched[name]["non_loss_rate"],
            int(models_and_checkpoints[name][1]["update"]),
        ),
    )
    selected_model, selected_checkpoint = models_and_checkpoints[selected_name]
    print(f"Selected {selected_name} at update {selected_checkpoint['update']}.", flush=True)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = args.output_dir / "rps_policy.onnx"
    onnx_data_path = args.output_dir / "rps_policy.onnx.data"
    for old_path in (onnx_path, onnx_data_path):
        if old_path.exists():
            old_path.unlink()
    export_onnx(selected_model, onnx_path, device)
    if not onnx_data_path.is_file():
        exported = onnx.load(str(onnx_path), load_external_data=True)
        onnx.save_model(
            exported,
            str(onnx_path),
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            location=onnx_data_path.name,
            size_threshold=0,
        )
    onnx_validation = validate_onnx(selected_model, onnx_path)
    if not onnx_data_path.is_file():
        raise RuntimeError("ONNX export did not produce its required external-data companion file.")
    export_json_weights(selected_model, args.output_dir / "rps_policy.weights.json")
    print(
        f"Evaluating the deployed policy against ARC and GTO for "
        f"{args.typescript_episodes} authoritative games each...",
        flush=True,
    )
    typescript = evaluate_authoritative_typescript_bots(
        args.typescript_episodes,
        args.seed + 40_000_000,
        args.output_dir / "server-bot-evaluation.json",
    )

    report = {
        "schema_version": 1,
        "selection": {
            "checkpoint": selected_name,
            "update": int(selected_checkpoint["update"]),
            "checkpoint_sha256": sha256(checkpoint_bytes[selected_name]).hexdigest(),
            "criterion": "highest matched-seed win rate versus Python heuristic",
        },
        "matched_python_heuristic": matched,
        "best_checkpoint_vs_final_checkpoint": {
            "perspective": "best.pt",
            **head_to_head,
        },
        "authoritative_typescript_bots": typescript,
        "seeds": {
            "base": args.seed,
            "checkpoint_environment": args.seed,
            "checkpoint_policy": args.seed + 10_000_000,
            "typescript": args.seed + 40_000_000,
        },
        "onnx_validation": onnx_validation,
    }
    (args.output_dir / "evaluation-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    deployed_spec = source_spec | {
        "deployed_checkpoint": report["selection"],
        "deployment_evaluation": {
            "matched_python_heuristic": matched[selected_name],
            "authoritative_typescript_bots": {
                "ARC": typescript["ARC"],
                "GTO": typescript["GTO"],
            },
        },
    }
    (args.output_dir / "model-spec.json").write_text(
        json.dumps(deployed_spec, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
