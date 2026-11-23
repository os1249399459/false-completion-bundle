"""Tests for the Python MCP verifier (run with pytest from repo root).

The LLM judge is auxiliary: a pass is impossible without a deterministic
signal. These tests prove that rule at the tool boundary.
"""

import asyncio
import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ("EVIDENCE_JSON", "VERIFIER_JUDGE_MODEL", "VERIFIER_JUDGE_API_KEY", "VERIFIER_BACKEND"):
        monkeypatch.delenv(key, raising=False)


def _server():
    return importlib.reload(importlib.import_module("server"))


def _call(payload):
    server = _server()
    return asyncio.run(server.mcp.call_tool("verify_claim", payload)).structured_content


def test_tool_is_registered():
    server = _server()
    names = [t.name for t in asyncio.run(server.mcp.list_tools())]
    assert names == ["verify_claim"]


def test_deterministic_support_yields_pass(monkeypatch):
    monkeypatch.setenv("EVIDENCE_JSON", '{"ev1": "the deployment succeeded after tests passed"}')
    result = _call({"claim_text": "the deployment succeeded after tests passed", "evidence_refs": ["ev1"]})
    assert result["kind"] == "pass"
    assert any(s["source"] == "deterministic" for s in result["deterministic_signals"])


def test_failed_deterministic_signal_yields_fail(monkeypatch):
    monkeypatch.setenv("EVIDENCE_JSON", '{"ev1": "unrelated content about cooking recipes"}')
    result = _call({"claim_text": "the deployment succeeded after tests passed", "evidence_refs": ["ev1"]})
    assert result["kind"] == "fail"


def test_judge_only_never_passes(monkeypatch):
    monkeypatch.setenv("VERIFIER_JUDGE_MODEL", "mock")
    monkeypatch.setenv("VERIFIER_JUDGE_API_KEY", "mock")
    result = _call({"claim_text": "quantum flux proves the deployment succeeded", "evidence_refs": ["missing"]})
    assert result["kind"] == "unknown"


def test_evidence_ref_is_stable(monkeypatch):
    monkeypatch.setenv("EVIDENCE_JSON", '{"ev1": "supporting text for the claim"}')
    first = _call({"claim_text": "supporting text for the claim", "evidence_refs": ["ev1"]})
    second = _call({"claim_text": "supporting text for the claim", "evidence_refs": ["ev1"]})
    assert first["evidence_ref"] == second["evidence_ref"]
