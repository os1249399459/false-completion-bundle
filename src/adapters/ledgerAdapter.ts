/**
 * Evidence ledger backed by OpenTelemetry spans.
 *
 * Thin adapter: redaction + hashing + a stable reference, then delegate export
 * to OTelEvidenceExporter. Fail-closed: if span emission fails, emitEvidence
 * rejects (and the tool-call integration must therefore fail the call).
 */
import { createHash } from 'node:crypto'
import type {
  EvidencePayload,
  EvidenceReference,
  JsonValue,
  LedgerAdapter,
  RedactedArguments,
  ToolOutcome,
} from './adapters.js'
import { OTelEvidenceExporter, type EvidenceSpanInput } from '../telemetry/otelExporter.js'

export interface LedgerConfig {
  /** Key names whose values are replaced with "[REDACTED]" before export. Case-insensitive. */
  redactKeys?: readonly string[]
  /** Extra key names to redact in addition to the defaults. */
  additionalRedactKeys?: readonly string[]
  /** Inject an exporter (tests use a spy). Defaults to a new OTelEvidenceExporter. */
  exporter?: Pick<OTelEvidenceExporter, 'emitEvidenceSpan'>
  /** Service/session identity attached to each span. */
  sessionId?: string
  /**
   * DSH profile name (e.g. "web"). Exported as `evidence.profile` so spans are
   * self-describing; `evidence.session.id` is kept for compatibility.
   */
  profileId?: string
  /** Called when span emission fails so the tool call can be failed. */
  onEmissionFailure?: (error: Error) => void
}

/** Keys redacted by default. Extend via `redactKeys` for deployment specifics. */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'authorization',
  'auth', 'credential', 'credentials', 'privatekey', 'private_key', 'accesskey',
  'access_key', 'sessiontoken', 'session_token', 'cookie', 'accesstoken',
  'access_token', 'refreshtoken', 'refresh_token', 'signature',
]

const REDACTED = '[REDACTED]'

/** Recursively redact object keys in a JSON value. Arrays are preserved structurally. */
export function redactJson(value: JsonValue, keys: readonly string[]): { value: JsonValue; redactedFields: string[] } {
  const normalized = new Set(keys.map((key) => key.toLowerCase()))
  const redactedFields: string[] = []

  const walk = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) return input.map(walk)
    if (input !== null && typeof input === 'object') {
      const output: Record<string, JsonValue> = {}
      for (const [key, child] of Object.entries(input)) {
        if (normalized.has(key.toLowerCase())) {
          output[key] = REDACTED
          redactedFields.push(key)
        } else {
          output[key] = walk(child)
        }
      }
      return output
    }
    return input
  }

  return { value: walk(value), redactedFields: [...new Set(redactedFields)].sort() }
}

/** Deterministic digest of any JSON value. Key order-independent for objects. */
export function digestJson(value: JsonValue): string {
  const canonical = stableStringify(value)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
  return `{${entries.join(',')}}`
}

function outcomeExitCode(outcome: ToolOutcome): string {
  if (outcome.isError) return outcome.error?.code ?? outcome.exitCode ?? 'ERROR'
  return outcome.exitCode || 'OK'
}

function outcomeToJson(outcome: ToolOutcome): JsonValue {
  return {
    isError: outcome.isError,
    exitCode: outcomeExitCode(outcome),
    error: outcome.error ? { name: outcome.error.name, code: outcome.error.code, reason: outcome.error.reason ?? null } : null,
    value: outcome.value ?? null,
    meta: outcome.meta ?? null,
  }
}

function snapshotToJson(payload: EvidencePayload): JsonValue {
  return {
    source: payload.snapshot.source,
    diffs: payload.snapshot.diffs.map((diff) => ({
      path: diff.path,
      oldText: diff.oldText,
      newText: diff.newText,
    })),
    beforeRef: payload.snapshot.beforeRef ?? null,
    afterRef: payload.snapshot.afterRef ?? null,
  }
}

/** A ledger entry with its success/failure bit, used by the claim guard. */
export interface LedgerEntry {
  readonly ref: string
  readonly ok: boolean
  readonly traceId?: string
  readonly spanId?: string
}

/** Lookup interface consumed by the claim guard. */
export interface LedgerReader {
  getEntry(ref: string): LedgerEntry | undefined
}

/**
 * Full evidence reference returned by emitEvidence. Extends the P0
 * EvidenceReference with the fields this phase requires. Structurally
 * compatible with LedgerAdapter.emitEvidence.
 */
export interface EvidenceRecord extends EvidenceReference {
  readonly traceId: string
  readonly spanId: string
  readonly toolName: string
  readonly argsHash: string
  readonly resultHash: string
  readonly exitCode: string
  readonly error?: { readonly name: string; readonly code: string }
  readonly timestamp: string
  readonly snapshot: JsonValue
}

export class OtelLedgerAdapter implements LedgerAdapter, LedgerReader {
  private readonly exporter: Pick<OTelEvidenceExporter, 'emitEvidenceSpan'>
  private readonly redactKeys: readonly string[]
  private readonly sessionId?: string
  private readonly profileId?: string
  private readonly entries = new Map<string, EvidenceReference>()
  private readonly ledgerEntries = new Map<string, LedgerEntry>()
  private readonly onEmissionFailure?: (error: Error) => void

  constructor(config: LedgerConfig = {}) {
    this.redactKeys = [
      ...DEFAULT_REDACT_KEYS,
      ...(config.additionalRedactKeys ?? []),
      ...(config.redactKeys ?? this.envRedactKeys()),
    ].map((key) => key.toLowerCase())
    this.sessionId = config.sessionId
    this.profileId = config.profileId
    this.onEmissionFailure = config.onEmissionFailure
    this.exporter =
      config.exporter ??
      new OTelEvidenceExporter({
        serviceName: 'dsh-false-completion-plugin',
        onEmissionFailure: config.onEmissionFailure,
      })
  }

  private envRedactKeys(): readonly string[] {
    return (process.env.AUDIT_REDACT_KEYS ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
  }

  /**
   * Redact arguments (derived view only — original DSH args are never mutated)
   * and compute a stable reference from the redacted payload.
   */
  redactArguments(toolName: string, args: JsonValue): RedactedArguments {
    const { value, redactedFields } = redactJson(args, this.redactKeys)
    return { toolName, args: value, redactedFields }
  }

  /**
   * Emit evidence and await OTLP delivery. On failure this rejects; the caller
   * MUST propagate that rejection so the tool call fails (never silently drop).
   */
  async emitEvidence(payload: EvidencePayload): Promise<EvidenceReference> {
    const reRedacted = redactJson(payload.redactedArgs.args, this.redactKeys)
    const prepared: EvidencePayload = {
      ...payload,
      redactedArgs: {
        toolName: payload.redactedArgs.toolName,
        args: reRedacted.value,
        redactedFields: reRedacted.redactedFields,
      },
    }

    // A per-emission session id (real DSH session) wins over the static one.
    const sessionId = prepared.sessionId ?? this.sessionId

    const argsHash = digestJson(prepared.redactedArgs.args)
    const resultHash = digestJson({
      outcome: outcomeToJson(prepared.outcome),
      snapshot: snapshotToJson(prepared),
    })
    const digest = digestJson({
      toolName: prepared.toolName,
      argsHash,
      resultHash,
      exitCode: outcomeExitCode(prepared.outcome),
    })
    const ref = `ev_${digest.slice(0, 32)}`
    const emittedAt = new Date().toISOString()

    // Include tool name, both hashes, exit/error, timestamp, and snapshot in
    // the exported span via attributes (all values already redacted/hashed).
    const attributes: EvidenceSpanInput['attributes'] = {
      'evidence.tool.name': prepared.toolName,
      'evidence.args.hash': argsHash,
      'evidence.result.hash': resultHash,
      'evidence.exit_code': outcomeExitCode(prepared.outcome),
      'evidence.error.name': prepared.outcome.error?.name ?? '',
      'evidence.error.code': prepared.outcome.error?.code ?? '',
      'evidence.timestamp': emittedAt,
      // OTel span attributes accept only primitives: serialize the snapshot
      // object to a JSON string so it survives export.
      'evidence.snapshot': JSON.stringify(snapshotToJson(prepared)),
      'evidence.redacted_fields': prepared.redactedArgs.redactedFields.join(','),
      ...(sessionId ? { 'evidence.session.id': sessionId } : {}),
      // Self-describing attribution: profile name distinguishes environments
      // even when the session id is generic.
      ...(this.profileId ? { 'evidence.profile': this.profileId } : {}),
      ...(prepared.repeated ? { 'evidence.repeated': true } : {}),
    }

    let emitted: EvidenceRecord
    try {
      const span = await this.exporter.emitEvidenceSpan({
        name: 'tool.call.evidence',
        attributes,
        evidenceRef: ref,
      })
      emitted = {
        ref,
        ...(sessionId ? { sessionId } : {}),
        callId: ref,
        digest,
        emittedAt,
        traceId: span.traceId,
        spanId: span.spanId,
        toolName: prepared.toolName,
        argsHash,
        resultHash,
        exitCode: outcomeExitCode(prepared.outcome),
        ...(prepared.outcome.error
          ? { error: { name: prepared.outcome.error.name, code: prepared.outcome.error.code } }
          : {}),
        timestamp: emittedAt,
        snapshot: snapshotToJson(prepared),
      }
      this.ledgerEntries.set(ref, {
        ref,
        ok: !prepared.outcome.isError,
        traceId: span.traceId,
        spanId: span.spanId,
      })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.onEmissionFailure?.(failure)
      throw failure
    }

    this.entries.set(ref, emitted)
    return emitted
  }

  readEvidence(ref: string): Promise<EvidenceReference | undefined> {
    return Promise.resolve(this.entries.get(ref))
  }

  /** Synchronous lookup for the claim guard. */
  getEntry(ref: string): LedgerEntry | undefined {
    return this.ledgerEntries.get(ref)
  }
}
