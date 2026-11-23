"""FastMCP wrapper for Python-grounded verifiers (Ragas / TruLens / DeepEval).

Single tool ``verify_claim(claim_text, evidence_refs)`` returns
``{kind, rationale, evidence_ref, deterministic_signals, judge}``.

Hard rule: a verdict is ``pass`` only when at least one deterministic signal
supports it. An LLM judge (Ragas faithfulness / TruLens groundedness /
DeepEval) is AUXILIARY and can never be the sole basis for ``pass`` --
judge-only positive results are downgraded to ``unknown``. Verifier algorithms
are imported from their packages, never reimplemented here.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any

from fastmcp import FastMCP

mcp = FastMCP("false-completion-python-verifier")

# ---------------------------------------------------------------------------
# Configuration (env driven)
# ---------------------------------------------------------------------------
VERIFIER_BACKEND = os.getenv("VERIFIER_BACKEND", "none").strip().lower()
JUDGE_MODEL = os.getenv("VERIFIER_JUDGE_MODEL", "")
OPENAI_API_KEY = os.getenv("VERIFIER_JUDGE_API_KEY", "")
DETERMINISTIC_THRESHOLD = float(os.getenv("VERIFIER_DETERMINISTIC_THRESHOLD", "0.7"))
JUDGE_THRESHOLD = float(os.getenv("VERIFIER_JUDGE_THRESHOLD", "0.7"))


@dataclass
class Signal:
    name: str
    score: float
    source: str  # "deterministic" | "judge"


@dataclass
class VerifyOutcome:
    kind: str  # pass | fail | unknown
    rationale: str
    evidence_ref: str
    deterministic_signals: list[Signal] = field(default_factory=list)
    judge: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "rationale": self.rationale,
            "evidence_ref": self.evidence_ref,
            "deterministic_signals": [
                {"name": s.name, "score": s.score, "source": s.source}
                for s in self.deterministic_signals
            ],
            "judge": self.judge,
        }


def _evidence_hash(claim_text: str, evidence_refs: list[str]) -> str:
    payload = json.dumps({"claim": claim_text, "refs": sorted(evidence_refs)}, sort_keys=True)
    return "py:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _load_evidence_texts(evidence_refs: list[str]) -> list[str]:
    """Resolve evidence refs to text via the EVIDENCE_JSON env mapping.

    Format: {"ev_...": "supporting text"}. Failed/missing refs resolve to empty
    text, which weakens deterministic support rather than inventing evidence.
    """
    raw = os.getenv("EVIDENCE_JSON", "{}")
    try:
        mapping = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return [str(mapping.get(ref, "")) for ref in evidence_refs]


def _deterministic_signals(claim_text: str, evidence_refs: list[str]) -> list[Signal]:
    """Compute lexical overlap against resolved evidence text.

    This is a deterministic lexical check, NOT a port of any verifier library.
    It supplies the required non-LLM signal. Library scores, when available,
    are added separately as judge signals.
    """
    evidence_texts = [text for text in _load_evidence_texts(evidence_refs) if text]
    if not evidence_texts:
        return []
    tokens = {t for t in claim_text.lower().split() if len(t) > 3}
    if not tokens:
        return []
    corpus = " ".join(evidence_texts).lower()
    covered = sum(1 for token in tokens if token in corpus)
    return [Signal("lexical_overlap", covered / len(tokens), "deterministic")]


def _judge_signal(claim_text: str, evidence_refs: list[str]) -> dict[str, Any] | None:
    """Optional auxiliary LLM judge via the selected Python verifier package.

    Keeping this behind a try/except means a missing/unconfigured judge never
    fails the tool: it simply produces no judge signal.
    """
    if not JUDGE_MODEL or not OPENAI_API_KEY:
        return None
    try:
        if VERIFIER_BACKEND == "ragas":
            from ragas.metrics import faithfulness  # type: ignore

            score = faithfulness.score(
                {"question": claim_text, "answer": claim_text, "contexts": _load_evidence_texts(evidence_refs)}
            )
            return {"name": "ragas_faithfulness", "score": float(score), "source": "judge"}
        if VERIFIER_BACKEND == "trulens":
            return {"name": "trulens_groundedness", "score": 0.0, "source": "judge", "status": "configure_provider"}
        if VERIFIER_BACKEND == "deepeval":
            return {"name": "deepeval_faithfulness", "score": 0.0, "source": "judge", "status": "configure_provider"}
    except Exception as exc:  # judge is auxiliary and must not break the tool
        return {"name": f"{VERIFIER_BACKEND}_judge", "score": 0.0, "source": "judge", "error": str(exc)}
    return None


@mcp.tool()
def verify_claim(claim_text: str, evidence_refs: list[str]) -> dict[str, Any]:
    """Verify a factual claim against evidence references.

    Returns pass|fail|unknown with rationale, evidence reference, deterministic
    signals, and optional auxiliary judge signal. A pass requires at least one
    deterministic signal meeting the configured threshold.
    """
    refs = list(evidence_refs or [])
    evidence_ref = _evidence_hash(claim_text, refs)
    deterministic = _deterministic_signals(claim_text, refs)
    judge = _judge_signal(claim_text, refs)

    supporting = [s for s in deterministic if s.score >= DETERMINISTIC_THRESHOLD]
    contradictory = [s for s in deterministic if s.score < DETERMINISTIC_THRESHOLD]

    if not deterministic:
        rationale = "No deterministic signal available (evidence unresolvable or no overlap)."
        if judge:
            rationale += " Judge output alone cannot produce a pass."
        return VerifyOutcome("unknown", rationale, evidence_ref, [], judge or {}).to_dict()

    if contradictory and not supporting:
        return VerifyOutcome(
            "fail",
            f"Deterministic signal below threshold ({contradictory[0].name}={contradictory[0].score:.2f}).",
            evidence_ref,
            deterministic,
            judge or {},
        ).to_dict()

    if supporting:
        return VerifyOutcome(
            "pass",
            f"Deterministic support: {supporting[0].name}={supporting[0].score:.2f}.",
            evidence_ref,
            deterministic,
            judge or {},
        ).to_dict()

    return VerifyOutcome("unknown", "No decisive signal.", evidence_ref, deterministic, judge or {}).to_dict()


if __name__ == "__main__":
    mcp.run()
