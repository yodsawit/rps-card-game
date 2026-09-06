"""Masked PPO self-play trainer for the two-player RPS card game.

Designed for Google Colab, but it also runs locally after installing the
dependencies in ``training/requirements-colab.txt``.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import random
import time
from typing import Optional, Union

import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

from training.rps_env import (
    ACTION_SIZE,
    HEART_LEVELS,
    MAX_TOTAL_HP,
    OBSERVATION_SIZE,
    RPSCardEnv,
    SYMBOL_COUNT,
    SYMBOLS,
)
from training.scripted_bots import ScriptedBotState, advanced_action, arc_action


class MaskedActorCritic(nn.Module):
    def __init__(self, observation_size: int = OBSERVATION_SIZE, hidden_size: int = 192):
        super().__init__()
        self.observation_size = observation_size
        self.hidden_size = hidden_size
        self.body = nn.Sequential(
            nn.Linear(observation_size, hidden_size),
            nn.Tanh(),
            nn.Linear(hidden_size, hidden_size),
            nn.Tanh(),
        )
        self.policy = nn.Linear(hidden_size, ACTION_SIZE)
        self.value = nn.Linear(hidden_size, 1)

    def forward(self, observation: torch.Tensor, legal_mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        features = self.body(observation)
        logits = self.policy(features)
        masked_logits = logits.masked_fill(~legal_mask.bool(), -1.0e9)
        return masked_logits, self.value(features).squeeze(-1)


@dataclass
class Transition:
    observation: np.ndarray
    legal_mask: np.ndarray
    action: int
    old_log_probability: float
    old_value: float
    target_return: float = 0.0


@dataclass
class EpisodeResult:
    winner: Optional[int]
    reason: str
    rounds: int
    steps: int
    mode: str
    learner_seat: Optional[int]
    transitions: list[Transition]


Controller = Union[MaskedActorCritic, str]


def neural_action(
    model: MaskedActorCritic,
    observation: list[float],
    legal_mask: list[bool],
    device: torch.device,
    deterministic: bool = False,
) -> tuple[int, float, float]:
    with torch.no_grad():
        obs_tensor = torch.tensor(observation, dtype=torch.float32, device=device).unsqueeze(0)
        mask_tensor = torch.tensor(legal_mask, dtype=torch.bool, device=device).unsqueeze(0)
        logits, value = model(obs_tensor, mask_tensor)
        distribution = Categorical(logits=logits)
        action_tensor = torch.argmax(logits, dim=-1) if deterministic else distribution.sample()
        log_probability = distribution.log_prob(action_tensor)
    return int(action_tensor.item()), float(log_probability.item()), float(value.item())


def heuristic_action(
    env: RPSCardEnv,
    player_index: int,
    legal_mask: list[bool],
    rng: random.Random,
    state: Optional[ScriptedBotState] = None,
) -> int:
    """Backward-compatible name for the production-aligned ARC controller."""
    return arc_action(env, player_index, legal_mask, rng, state or ScriptedBotState())


def random_action(legal_mask: list[bool], rng: random.Random) -> int:
    legal = [index for index, allowed in enumerate(legal_mask) if allowed]
    return rng.choice(legal)


def play_episode(
    learner: MaskedActorCritic,
    device: torch.device,
    seed: int,
    mode: str,
    learner_seat: Optional[int] = None,
    opponent_model: Optional[MaskedActorCritic] = None,
    collect: bool = True,
    deterministic: bool = False,
    hp_reward_weight: float = 0.0,
    table_seats: int = 2,
    scenario: Optional[str] = None,
) -> EpisodeResult:
    env = RPSCardEnv(seed=seed, table_seats=table_seats, scenario=scenario)
    rng = random.Random(seed ^ 0xA5A5A5A5)
    scripted_state = ScriptedBotState()
    if mode == "self":
        controllers: list[Controller] = [learner, learner]
        collected_players = {0, 1}
    else:
        if learner_seat not in (0, 1):
            raise ValueError("A learner seat is required outside pure self-play.")
        opponent: Controller
        if mode == "league":
            if opponent_model is None:
                raise ValueError("League play requires a frozen opponent model.")
            opponent = opponent_model
        elif mode in ("arc", "heuristic"):
            opponent = "arc"
        elif mode in ("gto", "advanced"):
            opponent = "gto"
        elif mode == "random":
            opponent = "random"
        else:
            raise ValueError(f"Unknown episode mode: {mode}")
        controllers = [opponent, opponent]
        controllers[learner_seat] = learner
        collected_players = {learner_seat}

    trajectories: list[list[Transition]] = [[], []]
    while not env.terminated:
        player = env.current_player
        observation = env.observe(player)
        legal_mask = env.legal_action_mask()
        controller = controllers[player]
        if isinstance(controller, MaskedActorCritic):
            action, log_probability, value = neural_action(
                controller, observation, legal_mask, device, deterministic=deterministic
            )
        elif controller == "arc":
            action = arc_action(env, player, legal_mask, rng, scripted_state)
            log_probability, value = 0.0, 0.0
        elif controller == "gto":
            action = advanced_action(env, player, legal_mask, rng, scripted_state)
            log_probability, value = 0.0, 0.0
        else:
            action = random_action(legal_mask, rng)
            log_probability, value = 0.0, 0.0
        if collect and player in collected_players and controller is learner:
            trajectories[player].append(Transition(
                observation=np.asarray(observation, dtype=np.float32),
                legal_mask=np.asarray(legal_mask, dtype=np.bool_),
                action=action,
                old_log_probability=log_probability,
                old_value=value,
            ))
        env.step(action)

    terminal_rewards = list(env.terminal_rewards())
    if hp_reward_weight:
        hp_difference = (env.players[0].hp - env.players[1].hp) / MAX_TOTAL_HP
        terminal_rewards[0] += hp_reward_weight * hp_difference
        terminal_rewards[1] -= hp_reward_weight * hp_difference
    transitions: list[Transition] = []
    for player, player_transitions in enumerate(trajectories):
        for transition in player_transitions:
            transition.target_return = terminal_rewards[player]
        transitions.extend(player_transitions)
    return EpisodeResult(
        winner=env.winner,
        reason=env.reason or "unknown",
        rounds=env.round,
        steps=env.step_count,
        mode=mode,
        learner_seat=learner_seat,
        transitions=transitions,
    )


def ppo_update(
    model: MaskedActorCritic,
    optimizer: torch.optim.Optimizer,
    transitions: list[Transition],
    device: torch.device,
    epochs: int,
    minibatch_size: int,
    clip_ratio: float,
    value_coefficient: float,
    entropy_coefficient: float,
    maximum_gradient_norm: float,
) -> dict[str, float]:
    observations = torch.tensor(np.stack([item.observation for item in transitions]), device=device)
    legal_masks = torch.tensor(np.stack([item.legal_mask for item in transitions]), device=device)
    actions = torch.tensor([item.action for item in transitions], dtype=torch.long, device=device)
    old_log_probabilities = torch.tensor(
        [item.old_log_probability for item in transitions], dtype=torch.float32, device=device
    )
    old_values = torch.tensor([item.old_value for item in transitions], dtype=torch.float32, device=device)
    target_returns = torch.tensor([item.target_return for item in transitions], dtype=torch.float32, device=device)
    advantages = target_returns - old_values
    advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1.0e-8)
    losses: list[tuple[float, float, float]] = []
    sample_count = len(transitions)
    for _ in range(epochs):
        permutation = torch.randperm(sample_count, device=device)
        for start in range(0, sample_count, minibatch_size):
            indices = permutation[start : start + minibatch_size]
            logits, values = model(observations[indices], legal_masks[indices])
            distribution = Categorical(logits=logits)
            log_probabilities = distribution.log_prob(actions[indices])
            ratio = torch.exp(log_probabilities - old_log_probabilities[indices])
            unclipped = ratio * advantages[indices]
            clipped = torch.clamp(ratio, 1.0 - clip_ratio, 1.0 + clip_ratio) * advantages[indices]
            policy_loss = -torch.minimum(unclipped, clipped).mean()
            value_loss = torch.square(values - target_returns[indices]).mean()
            entropy = distribution.entropy().mean()
            loss = policy_loss + value_coefficient * value_loss - entropy_coefficient * entropy
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), maximum_gradient_norm)
            optimizer.step()
            losses.append((float(policy_loss.item()), float(value_loss.item()), float(entropy.item())))
    return {
        "policy_loss": float(np.mean([loss[0] for loss in losses])),
        "value_loss": float(np.mean([loss[1] for loss in losses])),
        "entropy": float(np.mean([loss[2] for loss in losses])),
    }


def frozen_copy(model: MaskedActorCritic, device: torch.device) -> MaskedActorCritic:
    clone = MaskedActorCritic(model.observation_size, model.hidden_size).to(device)
    clone.load_state_dict(model.state_dict())
    clone.eval()
    for parameter in clone.parameters():
        parameter.requires_grad_(False)
    return clone


def evaluate(
    model: MaskedActorCritic,
    device: torch.device,
    episodes: int,
    seed: int,
    opponent: str = "arc",
    table_seats: tuple[int, ...] = (2, 3, 4, 5, 6),
    policy_seed: Optional[int] = None,
) -> dict[str, float | int]:
    wins = losses = draws = 0
    total_rounds = 0
    for index in range(episodes):
        learner_seat = index % 2
        if policy_seed is not None:
            torch.manual_seed(policy_seed + index)
        result = play_episode(
            model,
            device,
            seed + index,
            mode=opponent,
            learner_seat=learner_seat,
            collect=False,
            deterministic=False,
            table_seats=table_seats[index % len(table_seats)],
        )
        total_rounds += result.rounds
        if result.winner is None:
            draws += 1
        elif result.winner == learner_seat:
            wins += 1
        else:
            losses += 1
    return {
        "episodes": episodes,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "win_rate": wins / episodes,
        "non_loss_rate": (wins + draws) / episodes,
        "average_rounds": total_rounds / episodes,
    }


def evaluate_suite(
    model: MaskedActorCritic,
    device: torch.device,
    episodes: int,
    seed: int,
    policy_seed: int,
) -> dict[str, object]:
    arc = evaluate(model, device, episodes, seed, "arc", policy_seed=policy_seed)
    gto = evaluate(
        model,
        device,
        episodes,
        seed + 10_000_000,
        "gto",
        policy_seed=policy_seed + 10_000_000,
    )
    return {
        "episodes_per_opponent": episodes,
        "ARC": arc,
        "GTO": gto,
        "aggregate_win_rate": (float(arc["win_rate"]) + float(gto["win_rate"])) / 2,
        "aggregate_non_loss_rate": (
            float(arc["non_loss_rate"]) + float(gto["non_loss_rate"])
        ) / 2,
    }


def promotion_comparison(
    baseline: MaskedActorCritic,
    candidate: MaskedActorCritic,
    device: torch.device,
    episodes: int,
    seed: int,
) -> dict[str, object]:
    baseline_result = evaluate_suite(baseline, device, episodes, seed, seed + 30_000_000)
    candidate_result = evaluate_suite(candidate, device, episodes, seed, seed + 30_000_000)
    opponent_regressions = {
        opponent: float(candidate_result[opponent]["win_rate"])  # type: ignore[index]
        - float(baseline_result[opponent]["win_rate"])  # type: ignore[index]
        for opponent in ("ARC", "GTO")
    }
    aggregate_gain = float(candidate_result["aggregate_win_rate"]) - float(
        baseline_result["aggregate_win_rate"]
    )
    ready = aggregate_gain > 0 and min(opponent_regressions.values()) >= -0.02
    return {
        "schema_version": 1,
        "fixed_seed": seed,
        "episodes_per_opponent_per_checkpoint": episodes,
        "table_seats": [2, 3, 4, 5, 6],
        "baseline": baseline_result,
        "fine_tuned": candidate_result,
        "win_rate_change": opponent_regressions,
        "aggregate_win_rate_change": aggregate_gain,
        "promotion_ready": ready,
        "promotion_rule": (
            "Fine-tuned aggregate ARC/GTO-style win rate must improve and neither "
            "opponent win rate may regress by more than 0.02. Final promotion still "
            "requires the authoritative TypeScript gate."
        ),
    }


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
        "arguments": vars(arguments),
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
        checkpoint = torch.load(args.resume, map_location=device, weights_only=False)
        model.load_state_dict(checkpoint["model_state"])
        if "optimizer_state" in checkpoint:
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
        baseline_checkpoint = torch.load(
            args.baseline_checkpoint, map_location=device, weights_only=False
        )
        baseline_model = MaskedActorCritic(
            observation_size=int(baseline_checkpoint.get("observation_size", OBSERVATION_SIZE)),
            hidden_size=int(baseline_checkpoint.get("hidden_size", args.hidden_size)),
        ).to(device)
        baseline_model.load_state_dict(baseline_checkpoint["model_state"])
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
        "schema_version": 1,
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
