from __future__ import annotations
from dataclasses import dataclass
import random
from typing import Optional, Union
import numpy as np
import torch
from torch.distributions import Categorical
from training.model import MaskedActorCritic
from training.rps_env import RPSCardEnv, MAX_TOTAL_HP
from training.scripted_bots import ScriptedBotState, advanced_action, arc_action

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
