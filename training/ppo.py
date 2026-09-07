from __future__ import annotations
import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical
from training.model import MaskedActorCritic
from training.rollout import Transition

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
