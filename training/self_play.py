"""Masked PPO self-play trainer for the two-player RPS card game.

Designed for Google Colab, but it also runs locally after installing the
dependencies in ``training/requirements-colab.txt``.
"""

from __future__ import annotations

import argparse
from training.checkpoints import load_checkpoint, load_policy_state
import json
from pathlib import Path
import random
import time
from typing import Optional

import numpy as np
import torch

from training.rps_env import (
    ACTION_SIZE,
    HEART_LEVELS,
    OBSERVATION_SIZE,
    SYMBOLS,
)


# Compatibility exports keep existing notebooks and evaluation scripts working.
from training.model import MaskedActorCritic, frozen_copy
from training.rollout import Transition, EpisodeResult, Controller, neural_action, heuristic_action, random_action, play_episode
from training.ppo import ppo_update
from training.evaluation import evaluate, evaluate_suite, promotion_comparison
from training.artifacts import save_checkpoint, export_onnx


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--updates", type=int, default=200)
    parser.add_argument(
        "--additional-updates",
        type=int,
        help="Train this many updates beyond the resumed checkpoint (or update zero).",
    )
    parser.add_argument("--episodes-per-update", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--minibatch-size", type=int, default=512)
    parser.add_argument("--hidden-size", type=int, default=192)
    parser.add_argument("--learning-rate", type=float, default=3.0e-4)
    parser.add_argument("--clip-ratio", type=float, default=0.2)
    parser.add_argument("--value-coefficient", type=float, default=0.5)
    parser.add_argument("--entropy-coefficient", type=float, default=0.015)
    parser.add_argument("--maximum-gradient-norm", type=float, default=0.5)
    parser.add_argument("--arc-probability", type=float, default=0.25)
    parser.add_argument("--gto-probability", type=float, default=0.25)
    parser.add_argument(
        "--heuristic-probability",
        type=float,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--league-probability", type=float, default=0.25)
    parser.add_argument("--snapshot-every", type=int, default=10)
    parser.add_argument("--maximum-snapshots", type=int, default=8)
    parser.add_argument("--evaluate-every", type=int, default=10)
    parser.add_argument("--eval-episodes", type=int, default=100)
    parser.add_argument("--final-eval-episodes", type=int, default=200)
    parser.add_argument("--save-every", type=int, default=10)
    parser.add_argument("--hp-reward-weight", type=float, default=0.0)
    parser.add_argument("--seed", type=int, default=20260906)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/rps-self-play"))
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--baseline-checkpoint", type=Path)
    parser.add_argument("--promotion-eval-episodes", type=int, default=1_000)
    parser.add_argument("--scenario-probability", type=float, default=0.25)
    parser.add_argument(
        "--table-seats",
        default="2,3,4,5,6",
        help="Comma-separated production table sizes to cycle through during training.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_arguments()
    arc_probability = (
        args.arc_probability
        if args.heuristic_probability is None
        else args.heuristic_probability
    )
    if arc_probability + args.gto_probability + args.league_probability > 1.0:
        raise ValueError("ARC, GTO, and league probabilities must sum to at most 1.")
    table_seats = tuple(int(value.strip()) for value in args.table_seats.split(",") if value.strip())
    if not table_seats or any(value < 2 or value > 6 for value in table_seats):
        raise ValueError("--table-seats must contain only values from 2 through 6.")
    if args.baseline_checkpoint and args.promotion_eval_episodes < 1_000:
        raise ValueError("The fine-tune promotion gate requires at least 1,000 episodes per opponent.")
    if args.scenario_probability < 0 or args.scenario_probability > 1:
        raise ValueError("--scenario-probability must be between zero and one.")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = torch.device(
        "cuda" if args.device == "auto" and torch.cuda.is_available() else "cpu" if args.device == "auto" else args.device
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = args.output_dir / "metrics.jsonl"
    model = MaskedActorCritic(hidden_size=args.hidden_size).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    first_update = 1
    if args.resume:
        checkpoint = load_checkpoint(args.resume, device)
        migrated = load_policy_state(model, checkpoint["model_state"])
        if "optimizer_state" in checkpoint and not migrated:
            optimizer.load_state_dict(checkpoint["optimizer_state"])
        for parameter_group in optimizer.param_groups:
            parameter_group["lr"] = args.learning_rate
        first_update = int(checkpoint.get("update", 0)) + 1
        print(
            f"Resumed {args.resume}; next update is {first_update} and optimizer "
            f"learning rate is {args.learning_rate:g}."
        )

    final_update = (
        first_update - 1 + args.additional_updates
        if args.additional_updates is not None
        else args.updates
    )
    if final_update < first_update:
        raise ValueError("The requested final update is earlier than the next resumed update.")

    baseline_model: Optional[MaskedActorCritic] = None
    if args.baseline_checkpoint:
        baseline_checkpoint = load_checkpoint(args.baseline_checkpoint, device)
        baseline_model = MaskedActorCritic(
            observation_size=int(baseline_checkpoint.get("observation_size", OBSERVATION_SIZE)),
            hidden_size=int(baseline_checkpoint.get("hidden_size", args.hidden_size)),
        ).to(device)
        load_policy_state(baseline_model, baseline_checkpoint["model_state"])
        baseline_model.eval()
        for parameter in baseline_model.parameters():
            parameter.requires_grad_(False)

    snapshots: list[MaskedActorCritic] = [baseline_model] if baseline_model else []
    rng = random.Random(args.seed)
    started = time.time()
    best_win_rate = -1.0
    for update in range(first_update, final_update + 1):
        model.eval()
        transitions: list[Transition] = []
        episode_results: list[EpisodeResult] = []
        for episode in range(args.episodes_per_update):
            roll = rng.random()
            learner_seat = (update * args.episodes_per_update + episode) % 2
            episode_seed = args.seed + update * 100_000 + episode
            episode_table_seats = table_seats[
                (update * args.episodes_per_update + episode) % len(table_seats)
            ]
            scenario = None
            if rng.random() < args.scenario_probability:
                scenario_names = ("three_kind", "four_kind", "five_kind", "low_hp_draw", "max_hand")
                scenario = scenario_names[
                    (update * args.episodes_per_update + episode) % len(scenario_names)
                ]
            if roll < arc_probability:
                result = play_episode(
                    model,
                    device,
                    episode_seed,
                    "arc",
                    learner_seat,
                    hp_reward_weight=args.hp_reward_weight,
                    table_seats=episode_table_seats,
                    scenario=scenario,
                )
            elif roll < arc_probability + args.gto_probability:
                result = play_episode(
                    model,
                    device,
                    episode_seed,
                    "gto",
                    learner_seat,
                    hp_reward_weight=args.hp_reward_weight,
                    table_seats=episode_table_seats,
                    scenario=scenario,
                )
            elif roll < arc_probability + args.gto_probability + args.league_probability and snapshots:
                result = play_episode(
                    model,
                    device,
                    episode_seed,
                    "league",
                    learner_seat,
                    opponent_model=rng.choice(snapshots),
                    hp_reward_weight=args.hp_reward_weight,
                    table_seats=episode_table_seats,
                    scenario=scenario,
                )
            else:
                result = play_episode(
                    model,
                    device,
                    episode_seed,
                    "self",
                    hp_reward_weight=args.hp_reward_weight,
                    table_seats=episode_table_seats,
                    scenario=scenario,
                )
            transitions.extend(result.transitions)
            episode_results.append(result)
        model.train()
        losses = ppo_update(
            model,
            optimizer,
            transitions,
            device,
            args.epochs,
            args.minibatch_size,
            args.clip_ratio,
            args.value_coefficient,
            args.entropy_coefficient,
            args.maximum_gradient_norm,
        )
        if update % args.snapshot_every == 0:
            snapshots.append(frozen_copy(model, device))
            snapshots = snapshots[-args.maximum_snapshots :]

        evaluation = None
        if update % args.evaluate_every == 0 or update == final_update:
            model.eval()
            evaluation = evaluate_suite(
                model,
                device,
                args.eval_episodes,
                args.seed + 50_000_000 + update * args.eval_episodes,
                args.seed + 60_000_000 + update * args.eval_episodes,
            )
            if float(evaluation["aggregate_win_rate"]) > best_win_rate:
                best_win_rate = float(evaluation["aggregate_win_rate"])
                save_checkpoint(args.output_dir / "best.pt", model, optimizer, update, args)

        metric = {
            "update": update,
            "samples": len(transitions),
            "episodes": len(episode_results),
            "average_rounds": float(np.mean([result.rounds for result in episode_results])),
            "modes": {
                mode: sum(result.mode == mode for result in episode_results)
                for mode in ("self", "arc", "gto", "league")
            },
            "snapshots": len(snapshots),
            "elapsed_seconds": round(time.time() - started, 2),
            **losses,
            **({"evaluation": evaluation} if evaluation else {}),
        }
        with metrics_path.open("a", encoding="utf-8") as metrics_file:
            metrics_file.write(json.dumps(metric, sort_keys=True) + "\n")
        evaluation_text = "" if not evaluation else f" eval_win={float(evaluation['aggregate_win_rate']):.3f}"
        print(
            f"update={update:04d} samples={len(transitions):5d} "
            f"policy={losses['policy_loss']:+.4f} value={losses['value_loss']:.4f} "
            f"entropy={losses['entropy']:.3f}{evaluation_text}"
        )
        if update % args.save_every == 0 or update == final_update:
            save_checkpoint(args.output_dir / "latest.pt", model, optimizer, update, args)

    model.eval()
    final_evaluation = evaluate_suite(
        model,
        device,
        max(args.eval_episodes, args.final_eval_episodes),
        args.seed + 90_000_000,
        args.seed + 100_000_000,
    )
    save_checkpoint(args.output_dir / "final.pt", model, optimizer, final_update, args)
    export_onnx(model, args.output_dir / "rps_policy.onnx", device)
    fine_tune_evaluation = None
    if baseline_model:
        fine_tune_evaluation = promotion_comparison(
            baseline_model,
            model,
            device,
            args.promotion_eval_episodes,
            args.seed + 110_000_000,
        )
        (args.output_dir / "fine-tune-evaluation.json").write_text(
            json.dumps(fine_tune_evaluation, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    specification = {
        "schema_version": 2,
        "observation_size": OBSERVATION_SIZE,
        "action_size": ACTION_SIZE,
        "symbols": list(SYMBOLS),
        "heart_levels": HEART_LEVELS,
        "action_encoding": {
            "battle": "symbol_index * heart_levels + committed_hearts",
            "buy": {"0": "skip", "1": "spend one HP and draw"},
            "discard": {str(index): symbol for index, symbol in enumerate(SYMBOLS)},
        },
        "reward": "terminal win=1, draw=0, loss=-1 plus optional zero-sum HP tie-break",
        "hp_reward_weight": args.hp_reward_weight,
        "training_table_seats": list(table_seats),
        "scripted_opponents": {
            "ARC": "production-aligned symbol-level port",
            "GTO": "public-memory sampling plus approximate Bayesian maximin",
        },
        "final_evaluation_vs_python_scripted_bots": final_evaluation,
        "fine_tune_promotion_gate": fine_tune_evaluation,
        "training_arguments": vars(args) | {
            "output_dir": str(args.output_dir),
            "resume": str(args.resume) if args.resume else None,
            "baseline_checkpoint": str(args.baseline_checkpoint) if args.baseline_checkpoint else None,
            "final_update": final_update,
            "effective_arc_probability": arc_probability,
        },
    }
    (args.output_dir / "model-spec.json").write_text(json.dumps(specification, indent=2), encoding="utf-8")
    print(json.dumps({
        "output_dir": str(args.output_dir),
        "final_evaluation": final_evaluation,
        "fine_tune_promotion_gate": fine_tune_evaluation,
    }, indent=2))


if __name__ == "__main__":
    main()
