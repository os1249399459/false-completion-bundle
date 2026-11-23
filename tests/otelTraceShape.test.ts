/**
 * Assert the shape of a REAL OTLP trace captured from a DSH process.
 * Fixture: tests/fixtures/otel/<trace-id>.json (raw OTLP/JSON body).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(__dirname, 'fixtures', 'otel')
const files = readdirSync(fixtureDir).filter((name) => name.endsWith('.json'))

type OtlpSpan = {
  traceId?: string
  spanId?: string
  name?: string
  attributes?: Array<{ key: string; value?: Record<string, unknown> }>
}
type OtlpTrace = {
  resourceSpans?: Array<{
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>
  }>
}

function loadTraces(): OtlpTrace[] {
  return files.map((file) => JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')))
}

function spansOf(trace: OtlpTrace): OtlpSpan[] {
  return (trace.resourceSpans ?? []).flatMap((rs) => (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []))
}

function attributesOf(span: OtlpSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const attr of span.attributes ?? []) {
    const value = attr.value ?? {}
    out[attr.key] = Object.values(value)[0]
  }
  return out
}

const REQUIRED = [
  'evidence.tool.name',
  'evidence.args.hash',
  'evidence.result.hash',
  'evidence.exit_code',
  'evidence.timestamp',
  'evidence.ref',
]

describe('real OTLP trace shape', () => {
  it('has at least one captured trace', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const trace of loadTraces()) {
    const spans = spansOf(trace)
    it(`trace ${spans[0]?.traceId} has consistently named tool-call spans`, () => {
      expect(spans.length).toBeGreaterThan(0)
      for (const span of spans) {
        expect(span.name).toMatch(/^tool\.call\./)
        expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
        expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
      }
    })

    it(`trace ${spans[0]?.traceId} carries all required attributes`, () => {
      for (const span of spans) {
        const attrs = attributesOf(span)
        for (const key of REQUIRED) {
          expect(attrs, `missing ${key} on ${span.name}`).toHaveProperty(key)
          expect(String(attrs[key]).length).toBeGreaterThan(0)
        }
        expect(String(attrs['evidence.timestamp'])).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        expect(String(attrs['evidence.args.hash'])).toMatch(/^[0-9a-f]{64}$/)
        expect(String(attrs['evidence.result.hash'])).toMatch(/^[0-9a-f]{64}$/)
      }
    })

    it(`trace ${spans[0]?.traceId} leaks no secrets`, () => {
      const raw = JSON.stringify(trace)
      for (const forbidden of ['sk-', 'Authorization', 'DEEPSEEK_API_KEY', 'LANGFUSE_OTLP_AUTH_HEADER', 'Bearer ']) {
        expect(raw).not.toContain(forbidden)
      }
    })

    it(`trace ${spans[0]?.traceId} records the side-effect snapshot as a JSON string`, () => {
      for (const span of spans) {
        const attrs = attributesOf(span)
        // OTel rejects object attributes, so the snapshot must be serialized.
        expect(attrs, `missing evidence.snapshot on ${span.name}`).toHaveProperty('evidence.snapshot')
        expect(typeof attrs['evidence.snapshot']).toBe('string')
        expect(() => JSON.parse(String(attrs['evidence.snapshot']))).not.toThrow()
      }
    })
  }
})
