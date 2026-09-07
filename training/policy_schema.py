"""The same versioned contract imported by the production TypeScript policy."""
import json
from pathlib import Path

POLICY_SCHEMA = json.loads((Path(__file__).resolve().parents[1]
    / "packages/game-core/src/policy-schema.json").read_text(encoding="utf-8"))
