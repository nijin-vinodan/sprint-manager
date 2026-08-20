#!/usr/bin/env python3
"""
Scores raw issue feature rows against a saved predictor-evaluation winner
artifact (winner.joblib / winner.pkl). Invoked as a subprocess by
localInference.ts — never run directly against Jira/GitHub data itself,
just takes whatever feature rows the caller already extracted.

Contract (see predictorEvaluation.ts prompt, "SAVE THE WINNER"): the saved
artifact must be a full scikit-learn Pipeline (preprocessing + estimator)
that accepts the raw columns below directly — no external encoding step,
since the sandbox that trained it and this process that scores it are two
different environments and can't share in-memory encoders.

Usage: python3 infer.py <model_path> < feature_rows.json
  stdin:  JSON array of objects with keys issueType, priority, storyPoints
          (number or null), labels (string, "|"-joined — matches the CSV
          format the model was trained on), assignee (string or null),
          dependencyCount, commentCount, reopenCount.
  stdout: {"predictions": [<days>, ...]} on success, one per input row, in order.
  stderr + exit 1: {"error": "<message>"} on any failure (missing deps,
          incompatible artifact, bad input) — the Node caller falls back to
          k-NN when this happens, so failures here must never crash silently.
"""
import json
import sys

FEATURE_COLUMNS = [
    "issueType",
    "priority",
    "storyPoints",
    "labels",
    "assignee",
    "dependencyCount",
    "commentCount",
    "reopenCount",
]


def main() -> None:
    if len(sys.argv) != 2:
        raise ValueError("usage: infer.py <model_path>")
    model_path = sys.argv[1]

    import joblib
    import pandas as pd

    rows = json.load(sys.stdin)
    if not isinstance(rows, list) or not rows:
        raise ValueError("stdin must be a non-empty JSON array of feature rows")

    frame = pd.DataFrame(rows, columns=FEATURE_COLUMNS)
    model = joblib.load(model_path)
    predictions = model.predict(frame)
    print(json.dumps({"predictions": [float(p) for p in predictions]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - deliberately broad, see module docstring
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
