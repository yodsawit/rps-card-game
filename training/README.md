# RPS self-play training

This folder trains a two-duelist neural RPS policy in Google Colab. Both live
self-play seats share the same masked actor-critic network, so experience from
either side improves one policy. Fine-tuning mixes in a production-aligned ARC
port, a public-memory Bayesian/maximin opponent, and frozen historical policy
snapshots to reduce self-play cycles.

[Open the notebook in Colab](https://colab.research.google.com/github/yodsawit/rps-card-game/blob/main/training/RPS_Self_Play_Colab.ipynb)

## What is modeled

- Production deck sizes from 2 through 6 seats: `seats + 4` copies of each
  symbol. Two seats duel; the other starting hands are hidden reserves, which
  reproduces group-table deck uncertainty without pretending to train target
  selection or multi-duel tactics.
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

Twenty-five percent of training episodes start at a deliberately constructed,
legal post-mandatory-draw state. The curriculum covers three of a kind, four of
a kind, a retainable five of a kind, a legal low-HP paid draw, and a maximum
hand. These states preserve the correct deck total and are necessary because
rare draw/discard decisions otherwise contribute too few PPO samples.

## Training objective

The default reward is `+1` for winning, `0` for drawing, and `-1` for losing.
This makes the critic learn an estimate of eventual match success instead of
only the HP result of the current battle. `--hp-reward-weight` is available for
experiments but defaults to zero because even a small HP reward changes the
game objective and can encourage unnecessary delay.

The trainer uses clipped PPO with legal-action masking:

- 25% current-policy versus current-policy self-play;
- 25% versus the production-aligned Python ARC port;
- 25% versus the public-information Bayesian/maximin training opponent;
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
5. The notebook preserves the first `latest.pt` it sees as
   `pre-fine-tune.pt`, resumes the current checkpoint at the lower `1e-4`
   learning rate, and performs 200 *additional* updates. Further runs resume
   the latest checkpoint while comparing against the same frozen baseline. It
   stops with a clear error if Drive has no `latest.pt`, so a requested
   fine-tune cannot accidentally become fresh training; set `AUTO_RESUME=False`
   only when that is intentional.
6. At the end, the notebook runs 1,000 fixed-seed games per checkpoint per
   scripted opponent. The candidate passes this preliminary gate only if its
   mean ARC/GTO-style win rate improves and neither individual win rate drops
   by more than two percentage points.
7. Download the artifact ZIP. It includes the checkpoints, ONNX export, model
   specification, and `fine-tune-evaluation.json`.

The output directory contains:

- `latest.pt`, `best.pt`, and `final.pt` PyTorch checkpoints;
- `metrics.jsonl` training/evaluation history;
- `rps_policy.onnx` inference model;
- `model-spec.json` observation and action metadata.
- `pre-fine-tune.pt` frozen baseline and `fine-tune-evaluation.json` comparison
  when a prior checkpoint was available.

The ONNX file is not automatically trusted by the game server. Promotion first
runs fixed-seed evaluation against ARC, the current Advanced bot, and the other
learned checkpoint with both seat orders. The public server exposes the promoted
policy as a separate learned bot, leaving ARC and GTO available as controls.

## Evaluate and promote an artifact archive

Install the local CPU evaluation dependencies, then run the promotion command:

```powershell
python -m pip install --user torch numpy onnx onnxruntime onnxscript
$env:PYTHONUTF8='1'
python -m training.evaluate_artifacts "C:\path\to\rps-self-play-artifacts.zip" --episodes 2000 --typescript-episodes 1000
```

The evaluator gives `best.pt` and `final.pt` identical environment and policy
seeds, alternates their seats, runs a direct checkpoint matchup, and selects the
higher aggregate ARC/GTO-style fixed-seed win rate. Before replacing anything,
it evaluates the currently deployed weights for 1,000 games each against the
real TypeScript ARC and GTO. It then temporarily exports and evaluates the
candidate on the same seeds through the authoritative room manager. If the
candidate's aggregate win rate does not improve, or either matchup regresses by
more than two points, the previous ONNX, JSON weights, reports, and model spec
are restored and promotion exits with an error.

The Python maximin controller is deliberately a fast training surrogate: it
samples hands from only public memory and approximates the Bayesian equilibrium
with exponentiated subgradient updates. The final TypeScript gate is therefore
mandatory and uses the game's exact production GTO implementation.

Colab checkpoints written by Python 3.13 use the newer `pathlib._local` pickle
name. The evaluator includes a compatibility unpickler so they can be promoted
on Python 3.12 on Windows without changing the original ZIP.

## Local checks

The environment has no third-party dependency:

```powershell
python -m unittest discover -s training -p "test_*.py" -v
```

For local training, install PyTorch, NumPy, and the export dependencies, then:

```powershell
python -m training.self_play --additional-updates 20 --eval-episodes 50
```
