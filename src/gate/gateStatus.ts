/**
 * Read-only gate status tool support.
 *
 * Strictly read-only: reads env/config and (optionally) today's abort log.
 * It never evaluates claims, triggers retries, or emits evidence.
 */
import { readFileSync } from 'node:fs'
import {
  DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_STEPS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_STEPS_PER_TURN,
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
} from './completionGate.js'

export interface GateStatusInput {
  readonly env?: NodeJS.ProcessEnv
  readonly now?: Date
}

export interface GateStatus {
  readonly effective: {
    readonly maxRetries: number
    readonly maxStepsPerTurn: number
    readonly maxToolCallsPerTurn: number
    readonly maxConsecutiveNoProgressSteps: number
    readonly activeVerifiers: readonly string[]
    readonly profile: string
    readonly otelEndpoint: string
  }
  readonly abortLog: {
    readonly path: string
    readonly source: 'env' | 'none'
    readonly exists: boolean
    readonly entries: readonly string[]
    readonly error?: string
  }
}

/** Re-exported from the gate so the reported limits cannot drift from the
 *  enforced ones (same constants the constructor falls back to). */
const DEFAULT_LIMITS = {
  steps: DEFAULT_MAX_STEPS_PER_TURN,
  toolCalls: DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  noProgress: DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_STEPS,
} as const

/** Resolve the abort log path exactly like src/gate/abortLog.ts does. */
export function resolveAbortLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env['DSH_ABORT_LOG']
  return configured && configured.length > 0 ? configured : undefined
}

function activeVerifiers(env: NodeJS.ProcessEnv): string[] {
  const active = ['filesystem']
  if (env['DSH_FALSE_COMPLETION_PLAYWRIGHT'] === '1') active.push('playwright')
  if (env['GITHUB_TOKEN']) active.push('github')
  const backend = env['VERIFIER_BACKEND'] ?? ''
  if (['ragas', 'trulens', 'deepeval'].includes(backend)) active.push('python')
  return active
}

function readTail(path: string, count: number): { entries: string[]; error?: string } {
  try {
    const text = readFileSync(path, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    return { entries: lines.slice(-count) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Missing or unreadable log is normal and must never fail the tool.
    return { entries: [], error: message }
  }
}

/** Build the status snapshot without side effects. */
export function buildGateStatus(input: GateStatusInput = {}): GateStatus {
  const env = input.env ?? process.env
  const path = resolveAbortLogPath(env)
  const tail = path ? readTail(path, 5) : { entries: [] as string[] }

  return {
    effective: {
      maxRetries: Number(env['FALSE_COMPLETION_MAX_RETRIES'] ?? DEFAULT_MAX_RETRIES),
      maxStepsPerTurn: Number(env['FALSE_COMPLETION_MAX_STEPS'] ?? DEFAULT_LIMITS.steps),
      maxToolCallsPerTurn: Number(env['FALSE_COMPLETION_MAX_TOOL_CALLS'] ?? DEFAULT_LIMITS.toolCalls),
      maxConsecutiveNoProgressSteps: Number(env['FALSE_COMPLETION_MAX_NO_PROGRESS'] ?? DEFAULT_LIMITS.noProgress),
      activeVerifiers: activeVerifiers(env),
      profile: env['DSH_PROFILE'] ?? 'unknown',
      otelEndpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318 (default)',
    },
    abortLog: {
      path: path ?? '(unset — stderr only)',
      source: path ? 'env' : 'none',
      exists: tail.error === undefined,
      entries: tail.entries,
      ...(tail.error ? { error: tail.error } : {}),
    },
  }
}

/** Compact, chat-friendly rendering of the status snapshot. */
export function formatGateStatus(status: GateStatus): string {
  const e = status.effective
  const counts = [
    `maxRetries=${e.maxRetries}`,
    `steps=${e.maxStepsPerTurn}`,
    `toolCalls=${e.maxToolCallsPerTurn}`,
    `noProgress=${e.maxConsecutiveNoProgressSteps}`,
  ].join(' ')
  const lines: string[] = [
    '## Completion gate status',
    '',
    '**Effective config**',
    `- ${counts}`,
    `- active verifiers: ${e.activeVerifiers.join(', ')}`,
    `- profile: ${e.profile}`,
    `- otel endpoint: ${e.otelEndpoint}`,
    '',
    '**Abort log**',
    `- path: ${status.abortLog.path} (${status.abortLog.source})`,
  ]
  if (!status.abortLog.exists) {
    lines.push('- status: not created yet (no aborts recorded, or path unset)')
    if (status.abortLog.error) lines.push(`- note: ${status.abortLog.error}`)
  } else if (status.abortLog.entries.length === 0) {
    lines.push('- last entries: (file exists but is empty)')
  } else {
    lines.push(`- last ${status.abortLog.entries.length} entries:`)
    lines.push('```')
    lines.push(...status.abortLog.entries)
    lines.push('```')
  }
  return lines.join('\n')
}
