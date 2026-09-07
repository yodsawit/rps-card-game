from __future__ import annotations
import torch
from torch import nn
from training.rps_env import ACTION_SIZE, OBSERVATION_SIZE

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


def frozen_copy(model: MaskedActorCritic, device: torch.device) -> MaskedActorCritic:
    clone = MaskedActorCritic(model.observation_size, model.hidden_size).to(device)
    clone.load_state_dict(model.state_dict())
    clone.eval()
    for parameter in clone.parameters():
        parameter.requires_grad_(False)
    return clone
