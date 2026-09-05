# RPS self-play training

This folder trains a two-player neural RPS policy in Google Colab. Both live
self-play seats share the same masked actor-critic network, so experience from
either side improves one policy. Training also mixes in the Python heuristic
opponent and frozen historical policy snapshots to reduce self-play cycles.

[Open the notebook in Colab](https://colab.research.google.com/github/yodsawit/rps-card-game/blob/main/training/RPS_Self_Play_Colab.ipynb)

## What is modeled

- Six Rock, six Paper, and six Scissors cards in the two-player mutual deck.
- Three-card starting hands and hands capped at five after discard.
- Left-to-right hidden card placement with public committed HP.
- Irretractable card and HP commitments and forced remaining HP on lane three.
- Normal RPS resolution, transfer loss, triple overrides, bonus draws, optional
  HP-paid draws, discards returned to the shuffled deck, and five-card showdown.
- Each policy sees its own hand, all public match state, and the opponent's last
  two public hands and draw/discard records. It never sees hidden opponent cards
  or deck order.

Card IDs are collapsed to symbol counts because equal-symbol instances have no
strategic difference. Real-time timers and timeout fallbacks are omitted because
the action mask only permits complete legal actions. A 100-round draw guard
prevents pathological training episodes; normal games almost always end much
earlier.

## Training objective

The default reward is `+1` for winning, `0` for drawing, and `-1` for losing.
This makes the critic learn an estimate of eventual match success instead of
only the HP result of the current battle. `--hp-reward-weight` is available for
experiments but defaults to zero because even a small HP reward changes the
game objective and can encourage unnecessary delay.

The trainer uses clipped PPO with legal-action masking:

- 55% current-policy versus current-policy self-play;
- 20% versus the fixed Python heuristic by default;
- 25% versus a sampled frozen historical checkpoint once snapshots exist.

The exact percentages are command-line options. Training against historical
checkpoints matters because two continuously changing opponents can repeatedly
learn counters to one another without becoming robust.

## Colab workflow

1. Bookmark the public [GitHub-to-Colab notebook URL](https://colab.research.google.com/github/yodsawit/rps-card-game/blob/main/training/RPS_Self_Play_Colab.ipynb)
   and open that same URL for every training session. Do not save a separate
   notebook copy; this ensures notebook updates also come from GitHub.
2. Choose CPU or GPU runtime. This small model works on either.
3. Run all cells. The launcher clones or pulls the latest `main` branch, so
   pushed trainer/rule changes do not require a new notebook.
4. Google Drive stores only the artifacts. Persistence and automatic resume
   from `latest.pt` are enabled by default. Disable `AUTO_RESUME` after an
   incompatible model architecture change or when intentionally starting a
   fresh experiment.
5. Start with 200 total updates. When resuming, set `UPDATES` higher than the
   checkpoint's update number. Increase to 1,000 or more after verifying the learning
   curves and evaluation results.
6. Download `rps_policy.onnx`, `model-spec.json`, and the `.pt` checkpoint.

The output directory contains:

- `latest.pt`, `best.pt`, and `final.pt` PyTorch checkpoints;
- `metrics.jsonl` training/evaluation history;
- `rps_policy.onnx` inference model;
- `model-spec.json` observation and action metadata.

The ONNX file is not automatically trusted by the game server. It should first
pass fixed-seed evaluation against ARC, the current Advanced bot, and frozen
learned policies with both seat orders. Server-side feature encoding and ONNX
inference are a separate integration step so the existing bot remains available
as a safe fallback.

## Local checks

The environment has no third-party dependency:

```powershell
python -m unittest training.test_env -v
```

For local training, install PyTorch, NumPy, and the export dependencies, then:

```powershell
python -m training.self_play --updates 20 --eval-episodes 50
```
