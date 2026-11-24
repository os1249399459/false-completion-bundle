/**
 * Hermetic OTLP exporter doubles for tests.
 *
 * Tests must never reach the network. The production ledger is fail-closed: if
 * `emitEvidenceSpan` rejects, the caller aborts with `exporter_failed`. That is
 * correct behaviour, but it means a test that leaves the REAL exporter wired
 * up passes or fails depending on whether an OTLP sink happens to be listening
 * on 127.0.0.1:4318. That is how two suites came to pass locally and fail in
 * CI.
 *
 * `OtelLedgerAdapter` already accepts `config.exporter`, so the fix is to inject
 * one of these instead of changing any production code.
 */
import { vi } from 'vitest'

export interface MockExporterOptions {
  /** Span ids returned on success. Defaults are deterministic. */
  readonly traceId?: string
  readonly spanId?: string
}

/**
 * Resolves with dummy span ids — simulates a successful export delivery.
 * Records every call so tests can assert what would have been sent.
 */
export function createMockExporter(options: MockExporterOptions = {}) {
  const traceId = options.traceId ?? 'trace-mock-0001'
  const spanId = options.spanId ?? 'span-mock-0001'
  const emitEvidenceSpan = vi.fn(async () => ({ traceId, spanId }))
  return { emitEvidenceSpan, traceId, spanId }
}

/**
 * Rejects on every call — simulates an unreachable/failing collector WITHOUT a
 * real socket. This is the negative control for `exporter_failed`: it proves
 * the fail-closed path is exercised by an injected failure, not by the absence
 * of a local daemon.
 */
export function createFailingExporter(message = 'OTLP evidence export failed: mock collector unreachable') {
  const emitEvidenceSpan = vi.fn(async () => {
    throw new Error(message)
  })
  return { emitEvidenceSpan, message }
}

/**
 * A collector that fails only the Nth call onward. Lets a test drive a turn to
 * success and then break export mid-flight.
 */
export function createFlakyExporter(failFromCall = 1, message = 'OTLP evidence export failed: mock flake') {
  let calls = 0
  const emitEvidenceSpan = vi.fn(async () => {
    calls += 1
    if (calls >= failFromCall) throw new Error(message)
    return { traceId: `trace-mock-${calls}`, spanId: `span-mock-${calls}` }
  })
  return { emitEvidenceSpan, get callCount() { return calls } }
}
