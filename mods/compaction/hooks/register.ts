import type { EngineInterface, Register } from 'claude-code'

// Compaction requested by the model. Claude Code compacts only on /compact or at the
// auto-compact threshold, so often in the middle of a task, and until then every turn
// pays for the whole context. The `compact` tool lets the model request it at the end
// of a task; the compaction runs after the turn ends, like /compact.

export const TOOL = 'compact'
export const TOOL_ID = `mcp__compaction__${TOOL}`
// Below this, a summary does not save enough to be worth losing the details.
export const MIN_CONTEXT = 150_000

export const DESCRIPTION = [
  'Compacts the conversation (like /compact) right after the current turn ends.',
  `Call it as the last step of a finished task, when the context is over ~${MIN_CONTEXT / 1000}k and what comes next no longer needs the raw details (tool output, files read, attempts).`,
  'Do not call it in the middle of a task, with work or questions still open, nor when the user said that something depending on these details comes next.',
  `Below ${MIN_CONTEXT / 1000}k it refuses and reports the context size; above it, every user message comes with a [compaction] note with the size.`,
  '`instructions`: what the summary must keep (decisions, paths, current state, what comes next).',
].join(' ')

type State = { pending: { instructions: string | undefined } | undefined }

const kTokens = (n: number) => `${Math.round(n / 1000)}k`

// The model does not see its own context size; without this note it does not know when it crossed the threshold.
export const reminder = (tokens: number) =>
  `[compaction] The context has ${kTokens(tokens)} (over ${kTokens(MIN_CONTEXT)}). ` +
  `If your reply finishes a task or a stage (something approved, delivered, scheduled) and what comes next no longer needs the raw details, ` +
  `call ${TOOL_ID} as the last step, with instructions about what to keep. Do not call it in the middle of the work.`

export async function requestCompact($: EngineInterface, state: State, input: Record<string, unknown>): Promise<string> {
  const tokens = (await $.session.usage()).context.tokens ?? 0
  if (tokens < MIN_CONTEXT) return `Refused: the context has ${kTokens(tokens)}, below the ${kTokens(MIN_CONTEXT)} threshold. Do not compact now.`
  const text = typeof input.instructions === 'string' ? input.instructions.trim() : ''
  state.pending = { instructions: text === '' ? undefined : text }
  return `Scheduled: the conversation (${kTokens(tokens)}) is compacted after you finish the reply. End the turn normally, without other tools.`
}

export async function runCompact($: EngineInterface, instructions: string | undefined): Promise<void> {
  try {
    const done = await $.session.compact(instructions === undefined ? {} : { instructions })
    if (done.skip !== undefined) $.ui.toast(`compaction: stopped (${done.skip})`)
    else if (done.tokensBefore !== undefined && done.tokensAfter !== undefined)
      $.ui.log(`compaction: ${kTokens(done.tokensBefore)} -> ${kTokens(done.tokensAfter)}`)
  } catch {
    // In -p / SDK sessions $.session.compact is not available: there compaction is the /compact command.
    await $.command.run({ command: 'compact', args: instructions ?? '' }).catch((error: unknown) => {
      $.ui.toast(`compaction: failed (${error instanceof Error ? error.message : String(error)}); run /compact`)
    })
  }
}

export const register: Register = on => {
  const state: State = { pending: undefined }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { instructions: { type: 'string', description: 'What the summary keeps' } },
      },
    })
    return next(e)
  })

  // Always visible: with tool search, a deferred tool would be just a name.
  on('tool.describe', { tool: TOOL_ID }, ($, e) => ({ ...e, isDeferred: false }))

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'Refused: only the main session compacts its conversation.' }
    return { result: await requestCompact($, state, e) }
  })

  on('prompt.submit', async ($, e, next) => {
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (tokens < MIN_CONTEXT) return next(e)
    return next({ ...e, context: [...(e.context ?? []), reminder(tokens)] })
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && state.pending !== undefined) {
      const { instructions } = state.pending
      state.pending = undefined
      // Interrupted turn or error: never compact over something unfinished.
      // session.compact rejects while a turn runs: schedule it after the current dispatch.
      if (e.reason === 'answer') $.clock.after(0, () => void runCompact($, instructions))
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    state.pending = undefined
    return next(e)
  })
}
