from __future__ import annotations
from typing import Optional
import torch
from training.model import MaskedActorCritic
from training.rollout import play_episode

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
