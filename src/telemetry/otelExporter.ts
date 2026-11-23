/**
 * OpenTelemetry evidence exporter.
 *
 * Thin wiring only: NodeSDK + OTLP/HTTP exporter + a fail-closed wrapper.
 * Endpoint and auth come from environment variables (see .env.example).
 *
 * Fail-closed contract: `emitEvidenceSpan()` resolves only after the OTLP
 * exporter reports success. If export fails, the returned promise rejects and
 * calls `onEmissionFailure` so the tool-call adapter can block the call.
 */
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources'
import { type Span, type Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { JsonValue } from '../adapters/adapters.js'

export interface OTelExporterConfig {
  /** OTLP/HTTP endpoint. Env: OTEL_EXPORTER_OTLP_ENDPOINT or LANGFUSE_OTLP_ENDPOINT / PHOENIX_COLLECTOR_ENDPOINT. */
  endpoint?: string
  /** Auth header value. Env: OTEL_EXPORTER_OTLP_HEADERS or LANGFUSE_OTLP_AUTH_HEADER. */
  authHeader?: string
  /** Service name reported to the backend. Env: OTEL_SERVICE_NAME (default below). */
  serviceName?: string
  /** Resource attributes merged into the SDK resource. */
  resourceAttributes?: Record<string, string>
  /** Called synchronously when a span export fails; used to fail the tool call. */
  onEmissionFailure?: (error: Error) => void
}

export interface EvidenceSpanInput {
  /** Logical operation, e.g. "tool.call". */
  name: string
  /** Attributes to attach. Redaction happens before this function is called. */
  attributes: Record<string, string | number | boolean | JsonValue>
  /** Stable evidence reference emitted into the span's attributes. */
  evidenceRef: string
}

export interface EvidenceSpanResult {
  readonly traceId: string
  readonly spanId: string
}

/** Error thrown when OTLP export fails; callers must treat it as fatal for the tool call. */
export class EvidenceExportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EvidenceExportError'
  }
}

type PendingExport = {
  resolve: () => void
  reject: (error: Error) => void
}

/**
 * SpanExporter decorator that converts an export result into a promise so the
 * producer can await durable delivery. The underlying exporter is the official
 * OTLP implementation — no transport logic is reimplemented here.
 */
class AwaitableSpanExporter implements SpanExporter {
  private pending = new Map<string, PendingExport>()
  private readonly delegate: SpanExporter

  constructor(delegate: SpanExporter) {
    this.delegate = delegate
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.delegate.export(spans, (result) => {
      const ids = spans.map((span) => span.spanContext().spanId)
      if (result.code !== ExportResultCode.SUCCESS) {
        const error = new EvidenceExportError(
          `OTLP evidence export failed: ${result.error?.message ?? 'unknown exporter error'}`,
          { cause: result.error },
        )
        for (const id of ids) {
          const entry = this.pending.get(id)
          if (entry) {
            this.pending.delete(id)
            entry.reject(error)
          }
        }
      } else {
        for (const id of ids) {
          const entry = this.pending.get(id)
          if (entry) {
            this.pending.delete(id)
            entry.resolve()
          }
        }
      }
      resultCallback(result)
    })
  }

  /** Register a promise that settles when the span with this id exports. */
  track(spanId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.set(spanId, { resolve, reject })
    })
  }

  /** Resolve pending promises when a span never ends (e.g. sampling). */
  release(spanId: string): void {
    const entry = this.pending.get(spanId)
    if (entry) {
      this.pending.delete(spanId)
      entry.resolve()
    }
  }

  async forceFlush(): Promise<void> {
    await this.delegate.forceFlush?.()
  }

  async shutdown(): Promise<void> {
    await this.delegate.shutdown()
  }
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim() !== '') return value.trim()
  }
  return undefined
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (key) headers[key] = value
  }
  return headers
}

export class OTelEvidenceExporter {
  private readonly provider: BasicTracerProvider
  private readonly awaitable: AwaitableSpanExporter
  private readonly onEmissionFailure?: (error: Error) => void
  private readonly tracer: Tracer

  constructor(config: OTelExporterConfig = {}) {
    const endpoint =
      config.endpoint ??
      firstEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'LANGFUSE_OTLP_ENDPOINT', 'PHOENIX_COLLECTOR_ENDPOINT')
    const rawHeaders =
      config.authHeader ?? firstEnv('OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'OTEL_EXPORTER_OTLP_HEADERS', 'LANGFUSE_OTLP_AUTH_HEADER')
    const headers = parseHeaders(rawHeaders)
    const serviceName = config.serviceName ?? firstEnv('OTEL_SERVICE_NAME') ?? 'dsh-false-completion-plugin'

    const delegate = new OTLPTraceExporter({
      url: endpoint,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    })
    this.awaitable = new AwaitableSpanExporter(delegate)
    this.onEmissionFailure = config.onEmissionFailure

    // Bind directly to a private BasicTracerProvider instead of NodeSDK's
    // global provider: DSH mounts its own OTel service in the same process,
    // and the global provider singleton can resolve to a no-op/incompatible
    // provider. A private provider keeps evidence export deterministic.
    const resource: Resource = resourceFromAttributes({
      'service.name': serviceName,
      ...config.resourceAttributes,
    })
    this.provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(this.awaitable)],
    })
    this.tracer = this.provider.getTracer(serviceName)
  }

  start(): void {
    // BasicTracerProvider is ready on construction; no global registration.
  }

  /**
   * Emit one evidence span and await the OTLP result. Rejects on failure.
   * The caller MUST propagate the rejection to the tool call.
   */
  async emitEvidenceSpan(input: EvidenceSpanInput): Promise<EvidenceSpanResult> {
    this.start()
    const tracer = this.tracer!
    const span: Span = tracer.startSpan(input.name)
    const tracked = this.awaitable.track(span.spanContext().spanId)

    for (const [key, value] of Object.entries(input.attributes)) {
      span.setAttribute(key, value as string | number | boolean)
    }
    span.setAttribute('evidence.ref', input.evidenceRef)
    span.end()

    try {
      await tracked
      await this.awaitable.forceFlush()
    } catch (error) {
      const failure =
        error instanceof EvidenceExportError
          ? error
          : new EvidenceExportError('Failed to export evidence span', { cause: error })
      this.onEmissionFailure?.(failure)
      throw failure
    }

    const context = span.spanContext()
    return { traceId: context.traceId, spanId: context.spanId }
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown()
  }
}
