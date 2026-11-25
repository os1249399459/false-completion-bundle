# GETTING-STARTED — a first-day guide

For someone who has never seen this plugin. No DSH internals assumed.
Reading time ~10 minutes. Depth lives in `README.md`, `AUDIT.md`, `POSTMORTEM.md`.

---

## 1. The problem this solves

An AI agent can say "done" when it isn't. It ran no tests, wrote no file, read
nothing — but the final message claims success. A human reading the transcript
can't tell, because the lie looks exactly like a terse honest report.

This plugin makes that claim **checkable by code**. Before a turn is allowed to
end, the agent must produce a *claim document* that cites evidence, and the
evidence must resolve to something the system actually recorded.

Three sentences to hold onto:

1. **Claims are data, not prose.** The agent must emit JSON, not a paragraph.
2. **Evidence is recorded, not asserted.** A citation only counts if the ledger
   has an entry for it.
3. **The gate is code.** It can block the turn. It is not a prompt asking nicely.

---

## 2. Mental model in one diagram

```
agent does work (tool calls)
        │
        ▼
   evidence ledger  ──►  "ev_<hash>" reference for each action
        │                     (recorded in an OTel span)
        ▼
   agent writes a claim document:
   { claims: [ { text, status, evidence_ids, ... } ] }
        │
        ▼
   completion gate (code) checks:
        • is the JSON well-formed?            → claim_invalid
        • does every "done" claim cite ids?   → claim_invalid
        • do those ids resolve?               → evidence_missing
        • are cited entries successful?       → evidence_failed
        • did a verifier fail?                → verifier_failed
        • too many retries / steps / calls?   → retry_exhausted, *_budget_exceeded
        │
        ├── ok ────────► turn completes
        └── not ok ────► sends feedback and continues; on exhaustion, ABORTS
```

---

## 3. The claim document (the one thing to learn first)

The agent's final message must be this JSON (nothing else, no code fences):

```json
{
  "claims": [
    {
      "text": "Created config/app.yml with the retry settings",
      "status": "done",
      "evidence_ids": ["ev_3f2a91c8..."],
      "verification": {},
      "open_questions": [],
      "unverified_assumptions": []
    }
  ]
}
```

| Field | Rule |
|---|---|
| `text` | What is being claimed. Non-empty. |
| `status` | One of `done` / `partial` / `blocked` / `unknown`. **Only `done` requires evidence.** |
| `evidence_ids` | References from real tool calls. Empty for `done` = instant reject. |
| `verification` | Free-form object; may carry `{"type":"filesystem","path":"..."}`. |
| `open_questions` | Anything you could not resolve. |
| `unverified_assumptions` | Anything you assumed without checking. |

If the claim is `unknown` or `blocked`, you must **disclose it** in
`open_questions` or `unverified_assumptions` — an undisclosed unknown is treated
as a fake completion.

---

## 4. Why there are several verifiers

The ledger says *"this tool call happened and exited 0."* It cannot say *"the
file has the right contents."* Verifiers add that second opinion.

| Verifier | What it checks | Default |
|---|---|---|
| **filesystem** | file exists; content hash matches | **on** |
| **python** (grounding) | claim text supported by evidence text | off (needs a backend) |
| **playwright** | page element / text / browser state | off (needs a browser) |

At startup the plugin prints which ones are live and how to fix the others:

```
[false-completion-bundle] verifier probe:
  filesystem  OK
  python      SKIP (no deterministic backend configured; see README (Python setup section))
  playwright  SKIP (not enabled; run `npx playwright install chromium` to enable)
[false-completion-bundle] active gate: claimGuard + filesystem
```

That block is the fastest way to know what your install can actually verify.

---

## 5. How to check the gate's state (no terminal needed)

Ask the agent to run:

```
get_gate_status
```

It returns a read-only snapshot: retry budget, divergence limits, active
verifiers, the abort-log path, and the last 5 abort lines. It never evaluates a
claim or changes anything, so it is safe at any time — and it is the **first
thing to run when a turn aborts**.

---

## 6. Reading an abort

When the gate refuses to let a turn finish, it writes one greppable line:

```
[false-completion-gate] abort category=verifier_failed claim="Created foo.txt" evidence="ev_ab12" verifier=filesystem-mcp:"ENOENT" counts=- detail="ENOENT: no such file"
```

Only two things matter at first:

- **`category=`** — *why* it aborted.
- **`claim=` / `evidence=`** — *what* it was complaining about.

The ten categories and what each means in plain words:

| category | Plain meaning | What to do |
|---|---|---|
| `claim_invalid` | The JSON was malformed, or `done` with no evidence ids | Fix the claim document |
| `evidence_missing` | Cited an id the ledger doesn't have | Cite a real id, or redo the work |
| `evidence_failed` | The cited tool call failed | Fix the failure, then cite the new call |
| `verifier_failed` | A verifier ran and said no | Read `verifier=`; fix the actual defect |
| `retry_exhausted` | Gave feedback N times; agent didn't comply | Look at `detail=` for the real cause |
| `repeated_tool_call` | Same read-only call repeated with identical args | Stop repeating; use the previous result |
| `step_budget_exceeded` | Too many steps in one turn | Split the task |
| `tool_call_budget_exceeded` | Too many tool calls in one turn | Split the task |
| `no_progress_exceeded` | Several steps changed nothing | Change approach, not wording |
| `exporter_failed` | The trace sink is down — **not** a gate problem | Start the sink; this is infrastructure |

That last row is the classic beginner trap: an abort is not always the agent
misbehaving. `exporter_failed` means the audit trail couldn't be written, and the
gate is fail-closed by design.

---

## 7. First 15 minutes, hands on

```bash
# 1. is it installed and what does it verify?
dsh --profile work --dump-config | grep false-completion

# 2. start a local trace sink (otherwise every claim-bearing turn aborts)
bash ~/dsh/bundle/scripts/start-otlp-local-sink.sh

# 3. run one turn and ask for status
dsh --profile work --json 'Call get_gate_status once and paste its output.'

# 4. read today's abort log — but note it exists only if DSH_ABORT_LOG was set
grep 'category=' "${DSH_ABORT_LOG:-<unset>}"
```

**The abort log is opt-in per launch.** The `start_dsh.sh` launcher sets a dated
default *for the `web` profile only* (`~/.dsh/logs/aborts/web/$(date +%F).log`).
If you boot another profile directly (`dsh --profile work ...`), no file is
written unless you export it yourself:

```bash
export DSH_ABORT_LOG=~/.dsh/logs/aborts/work/$(date +%F).log
mkdir -p "$(dirname "$DSH_ABORT_LOG")"
```

Abort lines always go to **stderr** regardless; the file is only the durable copy.

Try breaking it on purpose — this is the fastest way to understand the gate:

```bash
dsh --profile work --json 'Reply with only this JSON: {"claims":[{"text":"I finished","status":"done","evidence_ids":[],"verification":{},"open_questions":[],"unverified_assumptions":[]}]}'
```

You should see the gate reject it (issue code `custom`: *A claim with status
"done" must cite at least one evidence_id*), send feedback, and — if the model
keeps insisting — abort with `category=claim_invalid`. Note the model may instead *refuse* to emit the false
claim; that is also a correct outcome. See `POSTMORTEM.md` §17.

---

## 8. Five rules a newcomer gets wrong

1. **`evidence_ids` are not quotes.** They are hashes the system issued. You
   cannot invent one; the gate checks the ledger.
2. **`partial` / `blocked` / `unknown` are honest, not failures.** Only `done`
   is scrutinised.
3. **A repeated identical read-only call is a smell.** The repetition guard
   flags it; use the cached result.
4. **Abort ≠ bug.** Check `category=` first. `exporter_failed` is ops, the rest
   are the agent.
5. **Don't edit profiles to "make it pass".** The gate defaults are deliberate;
   see `README.md#divergence-defaults`.

---

## 9. Where to look next

| You want… | Read |
|---|---|
| to install/build/verify | `BUILD.md` |
| day-to-day usage, config, profiles | `README.md` |
| what is proven vs assumed, fragility | `AUDIT.md` |
| why something was built this way | `POSTMORTEM.md` |
| "a turn just aborted, what now" | `TRIAGE.md` |
| exact names that must not change | `NAMING-INVENTORY.md`, `NAMING-DECISIONS.md` |
| runtime evidence (trace ids, sessions) | `ASSUMPTIONS.md` |

Glossary, in the order you will meet them:

- **claim document** — the JSON the agent must emit to end a turn.
- **evidence reference** — `ev_<hash>`, issued by the ledger for one action.
- **ledger** — append-only record of actions; emits OTel spans.
- **span** — one OpenTelemetry record; carries `evidence.*` attributes.
- **gate** — the code that accepts or blocks a claim document.
- **verifier** — an extra check beyond "the tool ran" (file hash, browser, …).
- **abort line** — the single greppable line describing a refusal.
- **fail-closed** — when the audit trail cannot be written, the turn fails.
