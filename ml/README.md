# Chem deep difficulty proxy

This directory is an offline research tool. The browser build does not import Python, PyTorch,
model weights, or a runtime service. The authoritative transition rules remain in
`src/games/chem/engine.ts`; Python talks to a persistent, vectorized TypeScript JSONL bridge.

## Environment

Use CPython 3.12 and `uv pip`; do not use bare `pip`:

```powershell
uv venv --python 3.12 ml/.venv
uv pip compile ml/requirements.in --python-version 3.12 --emit-index-url --emit-index-annotation --output-file ml/requirements.lock
uv pip sync --python ml/.venv ml/requirements.lock
```

The lock currently selects the official PyTorch CUDA 12.9 wheel. Verify the local device:

```powershell
ml/.venv/Scripts/python.exe -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0))"
```

## Tests and experiments

```powershell
ml/.venv/Scripts/python.exe -m unittest discover -s ml -p "test_*.py" -v

# Small protocol/training smoke test
ml/.venv/Scripts/python.exe ml/train_population.py --levels=1-3 --seeds=11 --episodes-per-level=32 --evaluation-every=16 --evaluation-trials=16

# Frozen phase-one run: official order, three common seeds, 3000 episodes per level ceiling
ml/.venv/Scripts/python.exe ml/train_population.py --levels=1-74 --seeds=11,29,47

# Same-seed redline counterfactual required before the deep proxy can enter curve decisions
ml/.venv/Scripts/python.exe ml/train_population.py --levels=1-74 --seeds=11,29,47 --remove-move-limits --output=artifacts/difficulty/deep-rl-no-limit.json

# Render the tracked comparison report after both formal conditions finish
ml/.venv/Scripts/python.exe ml/report_population.py

# LV.999 is isolated by a hard CLI guard
ml/.venv/Scripts/python.exe ml/train_population.py --levels=75 --seeds=11,29,47 --output=artifacts/difficulty/deep-rl-lv999.json
```

The report is an experimental machine proxy. It cannot trigger level edits unless it passes the
multi-seed and independent-proxy gates frozen in `docs/design.md` section 7.3.
