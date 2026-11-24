/**
 * Audit/evidence plugin — DSH lifecycle adapter declarations (phase 1).
 *
 * DSH version inspected: 0.2.1-rc.5. Every DSH symbol named in comments below
 * was confirmed against the live cordis inspect catalog, installed READMEs, and
 * installed lib/types/**\/*.d.ts in that version. See ../../ASSUMPTIONS.md.
 *
 * DESIGN RULE: no @deepseek-ai/* imports. All DSH-specific unknowns stay behind
 * these interfaces. This is a .d.ts file: types only, no implementation.
 *
 * KEY CONFIRMED MAPPINGS (do not guess replacements):
 * - DSH `tools/pre-execute`   : waterfall (exec: ToolExecution, next) => PreToolDecision
 *   `ToolExecution` fields used here: callId, rootCallId, name, arguments, agent?, parent?, signal.
 * - DSH `tools/post-execute`  : waterfall (exec, result: ToolExecutionResult, next) => PostToolDecision
 * - DSH `tools/result`        : emit (exec, result: Readonly<ToolExecutionResult>) => undefined
 * - DSH `ToolExecutionResult` : { isError: false; value; content; meta?; ... }
 *                             | { isError: true; error: { message; info?: {name, code, reason?} }; content; ... }
 * - DSH `FileDiff`            : { path: string; oldText: string | null; newText: string }
 *   (oldText=null means new file OR overwrite — no prior content at call time).
 * - DSH `agent/turn-stopping` : serial ({ agent, turn, signal }) => Promise<void> | void,
 *   awaited before the turn boundary commits. Feedback is delivered by calling
 *   `agent.steer(message: UserMessage)`; the machine re-reads its inbox.
 *   `agent.inject()` does NOT wake the driver. A tool result may set
 *   `concludesTurn` via ToolRunContext.concludeTurn().
 * - DSH has NO verifier/ledger/evidence service in this version. Ledger and
 *   verifier adapters are plugin-defined seams; their backends are TODO.
 *
 * CONFIRMED LIMITATION: `tools/pre-execute` cannot rewrite `exec.arguments`.
 * Redacted arguments are a DERIVED evidence view only. Do not mutate DSH args.
 */

/** Lossless JSON value boundary (mirrors DSH's JsonValue; kept structural here). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Opaque identifiers kept as strings at the adapter boundary. */
export type CallId = string;
export type RootCallId = string;
export type SessionId = string;
export type TurnNumber = number;

/** A single-file change, structurally identical to DSH `FileDiff`. */
export interface FileDiffSnapshot {
  readonly path: string;
  /** null = new file or overwrite (no prior content available at call time). */
  readonly oldText: string | null;
  readonly newText: string;
}

/**
 * Structured failure identity. DSH uses `ToolErrorInfo = { name, code, reason? }`
 * and cancellation codes "ABORTED" / "ABORTED_BEFORE_DISPATCH" (strings).
 * `exitCode` here is intentionally a plugin-normalized string, not a POSIX
 * integer — DSH does not expose a numeric exit code. (Assumption A2 / TODO-6.)
 */
export interface ToolFailureInfo {
  readonly name: string;
  readonly code: string;
  readonly reason?: string;
}

/** Normalized outcome shared by both tool-boundary hooks. */
export interface ToolOutcome {
  /** DSH `ToolExecutionResult.isError`. */
  readonly isError: boolean;
  /** DSH canonical execution-local value; may be absent on failure or in post-execute. */
  readonly value?: JsonValue;
  /** DSH model-facing rendered content (not necessarily lossless). */
  readonly content?: readonly JsonValue[];
  /** DSH replayable presentation payload persisted on `tool/result`. */
  readonly meta?: JsonValue;
  /** DSH structured failure identity; present when `isError` is true. */
  readonly error?: ToolFailureInfo;
  /**
   * Plugin-normalized string code. On success, conventionally "OK".
   * Derived from DSH `error.info.code`; see TODO-6 for the mapping table.
   */
  readonly exitCode: string;
}

/** Evidence-oriented view of one tool invocation's arguments. */
export interface RedactedArguments {
  /** DSH `ToolExecution.name` — the tool name, never redacted. */
  readonly toolName: string;
  /** Derived, redacted JSON view of DSH `ToolExecution.arguments`. Never mutate DSH args. */
  readonly args: JsonValue;
  /** Names of redacted fields, for auditability without leaking values. */
  readonly redactedFields: readonly string[];
}

/**
 * Where a snapshot/diff came from. DSH sources: tool presentation callbacks,
 * `meta`, or `ctx.workspaceChanges.diff`. See A4 / TODO-7.
 */
export type SnapshotSource = 'presentCall' | 'presentResult' | 'meta' | 'workspaceChanges' | 'unknown';

export interface Snapshot {
  readonly source: SnapshotSource;
  readonly diffs: readonly FileDiffSnapshot[];
  /** Opaque before/after handles when full text is not captured. */
  readonly beforeRef?: string;
  readonly afterRef?: string;
}

/** Context passed to `beforeToolCall` (DSH `tools/pre-execute`). */
export interface BeforeToolCallContext {
  readonly callId: CallId;
  readonly rootCallId: RootCallId;
  /** Agent turn number; scopes repetition fingerprints to a single turn. */
  readonly turn?: TurnNumber;
  readonly sessionId?: SessionId;
  /** Original DSH args. Read-only by contract; do not mutate. */
  readonly arguments: JsonValue;
  readonly toolName: string;
  /** DSH `exec.parent` presence marks a PTC sub-dispatch; absent = model-direct. */
  readonly isSubDispatch: boolean;
  readonly signal: AbortSignal;
}

export type BeforeToolCallDecision =
  /** Delegate to the DSH `next()` waterfall. */
  | { readonly kind: 'allow' }
  /** DSH `PreToolDecision` deny reason + optional structured error. */
  | { readonly kind: 'deny'; readonly reason: string; readonly info?: ToolFailureInfo }
  /** DSH `PreToolDecision` cancel (canonical pre-dispatch cancellation). */
  | { readonly kind: 'cancel' }
  /** DSH `PreToolDecision` ask; routed through the DSH approval service. */
  | { readonly kind: 'ask'; readonly reason?: string }
  /** Inject corrective feedback into the model but allow the call. */
  | { readonly kind: 'feedback'; readonly feedback: readonly JsonValue[] }
  /** Reject execution and reuse the cached result from the first call. */
  | { readonly kind: 'cached'; readonly result: JsonValue; readonly feedback: readonly JsonValue[] };

/** Context passed to `afterToolCall` (DSH `tools/post-execute`; observe via `tools/result`). */
export interface AfterToolCallContext {
  readonly callId: CallId;
  readonly rootCallId: RootCallId;
  /** Agent turn number; scopes repetition fingerprints to a single turn. */
  readonly turn?: TurnNumber;
  readonly sessionId?: SessionId;
  readonly toolName: string;
  readonly redactedArgs: RedactedArguments;
  readonly outcome: ToolOutcome;
  /** Best-effort diff/snapshot; empty when the tool exposes none. */
  readonly snapshot: Snapshot;
  readonly signal: AbortSignal;
}

export type AfterToolCallDecision =
  /** DSH `PostToolDecision.accept` (optionally replace model-facing content). */
  | { readonly kind: 'accept'; readonly content?: readonly JsonValue[] }
  /** DSH `PostToolDecision.block` — turns the result into an error with feedback. */
  | { readonly kind: 'block'; readonly feedback: readonly JsonValue[] };

/**
 * Audits the tool boundary.
 *
 * DSH registration sketch (NOT implemented here):
 *   ctx.on('tools/pre-execute', async (exec, next) => {
 *     const d = await adapter.beforeToolCall(mapExec(exec))
 *     return d.kind === 'allow' ? next() : mapPreDecision(d)
 *   })
 *   ctx.on('tools/post-execute', async (exec, result, next) => { ... })
 *   ctx.on('tools/result', (exec, result) => { ... })  // observe-only final snapshot
 *
 * A monotonic deny that must survive listener reordering is additionally
 * expressible with `ctx.tools.guard()`; that is a later-phase decision.
 */
export interface ToolBoundaryAdapter {
  /** Map to DSH `tools/pre-execute` waterfall. */
  beforeToolCall(ctx: BeforeToolCallContext): Promise<BeforeToolCallDecision>;

  /**
   * Map to DSH `tools/post-execute` waterfall. The DSH `ToolExecutionResult`
   * already contains isError, value?, content, meta?, error?.
   */
  afterToolCall(ctx: AfterToolCallContext): Promise<AfterToolCallDecision>;
}

/** Context for the completion hook (DSH `agent/turn-stopping`, serial mode). */
export interface CompletionContext {
  readonly sessionId?: SessionId;
  readonly turn: TurnNumber;
  /** Whether a tool result has marked this turn terminal (DSH `concludesTurn`). */
  readonly concludesTurn: boolean;
  readonly signal: AbortSignal;
}

/**
 * Outcome of the pre-completion check. There is NO waterfall veto on
 * `agent/turn-stopping`: feedback is delivered by `agent.steer(message)` and
 * abort by `agent.cancel(cause)`. This adapter expresses intent only; the
 * DSH-specific delivery implementation is a later-phase TODO (TODO-3).
 */
import type { AbortCategory } from '../gate/abortReason.js'

export type CompletionDecision =
  /** Let the turn close (do not steer or cancel). */
  | { readonly kind: 'complete' }
  /** Inject corrective feedback, forcing another step via `agent.steer(...)`. */
  | { readonly kind: 'feedback'; readonly feedback: readonly JsonValue[] }
  /** Hard-abort the turn via `agent.cancel(...)` (not a waterfall veto). */
  | {
      readonly kind: 'abort';
      /** Legacy string reason (backward compatible). */
      readonly reason: string;
      /** Structured twin; optional so existing callers keep compiling. */
      readonly abortDetail?: {
        readonly kind: 'hook';
        readonly category: AbortCategory;
        readonly claim_text?: string;
        readonly evidence_ids?: readonly string[];
        readonly verifier?: { readonly type: string; readonly detail: string };
        readonly counts?: { readonly actual: number; readonly limit: number };
        readonly detail: string;
      };
    };

/**
 * Runs just before the agent loop finishes a turn.
 * DSH registration sketch: `ctx.on('agent/turn-stopping', async ({agent, turn, signal}) => {...})`.
 * A feedback decision MUST be delivered with `agent.steer()`, never `agent.inject()`,
 * because inject does not wake the driver. (A6 / A7 / TODO-3 / TODO-10.)
 */
export interface CompletionHookAdapter {
  beforeCompletion(ctx: CompletionContext): Promise<CompletionDecision>;
}

/** Stable reference emitted by the ledger. Must be reproducible, not time-based. */
export interface EvidenceReference {
  /** Stable key, e.g. derived from sessionId + callId (A5 / TODO-9). */
  readonly ref: string;
  readonly sessionId?: SessionId;
  readonly callId: CallId;
  readonly rootCallId?: RootCallId;
  /** Digest of the canonical evidence payload (TODO-5). */
  readonly digest: string;
  readonly emittedAt: string;
}

/** The payload whose digest forms the stable evidence reference. */
export interface EvidencePayload {
  readonly toolName: string;
  readonly redactedArgs: RedactedArguments;
  readonly outcome: ToolOutcome;
  readonly snapshot: Snapshot;
  /**
   * Real DSH Session id for this emission when the caller can reach the
   * Agent/Session. Overrides the adapter-level `sessionId`. Optional so
   * existing callers remain compatible.
   */
  readonly sessionId?: SessionId;
  /** True when this call reused a cached result from a repeat in the same turn. */
  readonly repeated?: boolean;
}

/**
 * Emits a stable evidence reference from tool-call data.
 *
 * No DSH service provides this. The eventual implementation should derive from
 * existing `tool/call` + `tool/result` session events and store plugin-owned
 * data via `ctx.storage`; it must NOT append a new session event type (section
 * 1.5 of ASSUMPTIONS.md). Backend and hashing are TODO-4 / TODO-5.
 */
export interface LedgerAdapter {
  emitEvidence(payload: EvidencePayload): Promise<EvidenceReference>;
  /** Read back a previously emitted reference; undefined when not found. */
  readEvidence(ref: string): Promise<EvidenceReference | undefined>;
}

/** A claim dispatched to an external verifier. */
export interface VerificationClaim {
  /** Stable claim id chosen by the caller. */
  readonly claimId: string;
  /** The subject being claimed, as redacted JSON. */
  readonly subject: JsonValue;
  /** Optional evidence references supporting this claim. */
  readonly evidenceRefs: readonly string[];
}

export type Verdict =
  | { readonly kind: 'pass'; readonly detail?: JsonValue }
  | { readonly kind: 'fail'; readonly detail?: JsonValue }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Dispatches a claim to an external verifier.
 *
 * No DSH verifier service exists in 0.2.1-rc.5. `ctx.web.fetch` is a possible
 * transport but is NOT assumed here. Endpoint, auth, schema, timeout,
 * idempotency, and PII rules are all TODO-8. This interface is a pure seam;
 * no HTTP, no schema validation, and no verdict logic is implemented in phase 1.
 */
export interface VerifierAdapter {
  verify(claim: VerificationClaim, signal?: AbortSignal): Promise<Verdict>;
}
