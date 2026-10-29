import type { On, SessionCompactInput } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { TOOL_ID } from '../hooks/register.ts'

// The headless path ($.session.compact rejected -> the /compact command) cannot be
// simulated in the kit: a session.compact hook that throws is skipped, not rejected.
// It was verified live with `claude -p`.

type World = { clock: MockClock; tokens: number; compacts: SessionCompactInput[]; logs: string[]; toasts: string[] }

function world(on: On): World {
  const w: World = { clock: mock.clock(on, { now: 0 }), tokens: 200_000, compacts: [], logs: [], toasts: [] }
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: w.tokens, window: 433_000, percent: 0 }, rateLimits: [] },
  }))
  on('session.compact', ($, e) => {
    w.compacts.push(e)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: w.tokens, tokensAfter: 20_000 }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

const ask = ($: Engine, input: Record<string, unknown> = {}, agentId?: string) =>
  $.tool.call({ tool: TOOL_ID, ...input, agentId } as never) as Promise<{ result?: unknown }>

const finishTurn = ($: Engine, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: reason === 'aborted', turnId: 't1', reason })

const flush = async (clock: MockClock) => {
  for (let i = 0; i < 6; i += 1) await clock.settle()
}

describe('compact', () => {
  test('over the threshold: scheduled, runs once after the turn, with the instructions', async ($, on) => {
    const w = world(on)
    const said = await ask($, { instructions: 'keep the paths' })
    expect(String(said.result)).toMatch(/^Scheduled: the conversation \(200k\)/)
    expect(w.compacts.length).toBe(0)
    await finishTurn($)
    await flush(w.clock)
    expect(w.compacts.length).toBe(1)
    expect(w.compacts[0]?.instructions).toBe('keep the paths')
    expect(w.logs).toEqual(['compaction: 200k -> 20k'])
    await finishTurn($)
    await flush(w.clock)
    expect(w.compacts.length).toBe(1)
  })

  test('below the threshold: refuses and reports the size; nothing after the turn', async ($, on) => {
    const w = world(on)
    w.tokens = 90_000
    const said = await ask($)
    expect(String(said.result)).toMatch(/^Refused: the context has 90k/)
    await finishTurn($)
    await flush(w.clock)
    expect(w.compacts.length).toBe(0)
  })

  test('without instructions: the engine compaction, without instructions', async ($, on) => {
    const w = world(on)
    await ask($, { instructions: '  ' })
    await finishTurn($)
    await flush(w.clock)
    expect(w.compacts.length).toBe(1)
    expect(w.compacts[0]?.instructions).toBeUndefined()
  })

  test('a subagent cannot compact', async ($, on) => {
    const w = world(on)
    const said = await ask($, {}, 'agent-1')
    expect(String(said.result)).toMatch(/^Refused: only the main session/)
    await finishTurn($)
    await flush(w.clock)
    expect(w.compacts.length).toBe(0)
  })

  test('the context note: only over the threshold, next to what was already there', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    const submit = () =>
      $.prompt.submit({ text: 'go on', context: ['something else'], wait: false, origin: { kind: 'composer' } } as never) as Promise<{
        context?: readonly string[]
      }>
    w.tokens = 264_000
    const above = await submit()
    expect(above.context?.[0]).toBe('something else')
    expect(above.context?.[1]).toMatch(/^\[compaction\] The context has 264k \(over 150k\)/)
    w.tokens = 120_000
    expect((await submit()).context).toEqual(['something else'])
  })

  test('interrupted turn: gives up, also on the next turn', async ($, on) => {
    const w = world(on)
    await ask($)
    await finishTurn($, 'aborted')
    await flush(w.clock)
    await finishTurn($)
    await flush(w.clock)
    expect(w.compacts.length).toBe(0)
  })
})
