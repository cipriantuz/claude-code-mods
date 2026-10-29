import type { On, SessionMessage } from 'claude-code'
import type { Engine, MockClock, MockSession } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { NEW_SESSION, STAY, condense, formatDuration, notePath } from '../hooks/note.ts'

// The kit stores the plugin's `$.session.append` row (`mock.session` records it); a
// test that needs the fallback path (note and prompt back in the box) refuses the row
// with its own `session.append` hook.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = new Date(2026, 9, 3, 12, 0).getTime()
const SESSION = 'abcdef12-3456-7890-abcd-ef1234567890'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: '<system-reminder>long CLAUDE.md</system-reminder>do X', toolUses: [] },
  {
    role: 'assistant',
    text: 'Did X.',
    toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, isError: true }],
  },
]

// The world under the plugin: what the user picks in the dialog, the context, and everything that reached it.
type World = {
  clock: MockClock
  session: MockSession
  answer: string | undefined
  tokens: number
  // `session.usage` answers late: like a late timer, the machine slept.
  usageDelayMs: number
  forkFails: boolean
  // The fork writes the context into the cache instead of reading it.
  forkCold: boolean
  completeFails: boolean
  completeDelayMs: number
  asked: string[]
  order: string[]
  // The minutes (from START) at which a fork was requested.
  forkMinutes: number[]
  submits: { text: string; origin: string }[]
  completes: string[]
  writes: { path: string; text: string }[]
  fills: string[]
  toasts: string[]
}

function world(on: On): World {
  const w: World = {
    clock: mock.clock(on, { now: START }),
    session: mock.session(on),
    answer: STAY,
    tokens: 250_000,
    usageDelayMs: 0,
    forkFails: false,
    forkCold: false,
    completeFails: false,
    completeDelayMs: 0,
    asked: [],
    order: [],
    forkMinutes: [],
    submits: [],
    completes: [],
    writes: [],
    fills: [],
    toasts: [],
  }
  mock.env(on, { USERPROFILE: 'C:/Profiles/user' })
  on('session.usage', async () => {
    if (w.usageDelayMs > 0) await w.clock.sleep(w.usageDelayMs)
    return {
      value: {
        startedAt: 0,
        context: { tokens: w.tokens, window: 1_000_000, percent: Math.round(w.tokens / 10_000) },
        rateLimits: [],
      },
    }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    w.order.push('submit')
    w.submits.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text, origin: e.origin }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    if (e.tool !== 'AskUserQuestion') return { deny: 'unexpected' }
    const asked = e.questions[0]?.question ?? ''
    w.asked.push(asked)
    if (w.answer === undefined) return { deny: 'the user closed the dialog' }
    return {
      result: { questions: e.questions, answers: { [asked]: w.answer } },
      text: `User has answered your questions: "${asked}"="${w.answer}". You can now continue with the user's answers in mind.`,
    }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.fork', () => {
    w.order.push('fork')
    w.forkMinutes.push((w.clock.now() - START) / MINUTE)
    if (w.forkFails) return { value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
    const usage = w.forkCold
      ? { ...USAGE, cache_creation_input_tokens: w.tokens }
      : { ...USAGE, cache_read_input_tokens: w.tokens }
    return { value: { isAnswered: true, text: '## Task\nX (fork)', usage } }
  })
  on('model.complete', async ($, e) => {
    w.order.push('complete')
    w.completes.push(e.prompt)
    if (w.completeDelayMs > 0) await w.clock.sleep(w.completeDelayMs)
    if (w.completeFails) return { value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
    return { value: { isAnswered: true, text: '## Task\nX (condensed)', usage: USAGE } }
  })
  on('fs.write', ($, e) => {
    w.order.push('write')
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.run', { command: 'clear' }, () => {
    w.order.push('clear')
    return { text: '' }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return w
}

// The text of the rows appended to the new session (the handoff note).
const appendedText = (w: World) =>
  w.session
    .appended()
    .flatMap(row => {
      const content = (row.message as { content?: unknown }).content
      return Array.isArray(content) ? content.map(block => String((block as { text?: unknown }).text ?? '')) : [String(content ?? '')]
    })
    .join('\n')

// The store refuses the row: the plugin takes the fallback path.
const refuseAppend = (on: On) => on('session.append', { door: 'note' }, () => ({ deny: 'store unavailable' }))

const finishTurn = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer', agentId })

// What the user would have typed in the box.
const typed = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const handoffCommand = ($: Engine, args: string) =>
  $.command.run({ command: 'handoff', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const flush = async (clock: MockClock) => {
  for (let i = 0; i < 6; i += 1) await clock.settle()
}

describe('note', () => {
  test('duration, file path', () => {
    expect(formatDuration(2 * HOUR)).toBe('2 h')
    expect(formatDuration(2 * HOUR + 10 * MINUTE)).toBe('2 h 10 min')
    expect(formatDuration(45 * MINUTE)).toBe('45 min')
    expect(notePath('C:/Profiles/user/.claude/handoffs/', new Date(2026, 9, 3, 18, 42).getTime(), SESSION)).toBe(
      'C:/Profiles/user/.claude/handoffs/2026-10-03_1842_abcdef12.md',
    )
    expect(notePath('C:\\Profiles\\user/.claude/handoffs', new Date(2026, 9, 3, 9, 5).getTime(), SESSION)).toBe(
      'C:/Profiles/user/.claude/handoffs/2026-10-03_0905_abcdef12.md',
    )
  })

  test('condensed transcript: no system-reminder, tools in short', () => {
    const text = condense(MESSAGES)
    expect(text).toBe('USER: do X\nASSISTANT: Did X.\n  [Bash] npm test (error)')
  })

  test('over budget it keeps the beginning and the newest part', () => {
    const many: SessionMessage[] = Array.from({ length: 400 }, (_, i) => ({
      role: 'assistant' as const,
      text: `step ${i} ${'x'.repeat(100)}`,
      toolUses: [],
    }))
    const text = condense(many, 20_000)
    expect(text.length).toBeLessThanOrEqual(20_500)
    expect(text).toMatch(/^ASSISTANT: step 0 /)
    expect(text).toMatch(/lines omitted/)
    expect(text).toMatch(/step 399 x+$/)
  })
})

describe('the dialog after a pause', () => {
  test('asks after a long pause with a large context; "Continue here" lets the prompt in', async ($, on) => {
    const w = world(on)
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    const said = await typed($, 'go on')
    expect(said.drop).toBeUndefined()
    expect(w.asked.length).toBe(1)
    expect(w.asked[0] ?? '').toMatch(/^Paused for 2 h: the cache has expired, and the context has 250k tokens/)
    expect(w.submits.map(one => one.text)).toEqual(['go on'])
    expect(w.order).not.toContain('clear')
  })

  test('does not ask: no finished turn, short pause, small context, queued prompt, notification', async ($, on) => {
    const w = world(on)
    await typed($, 'first')
    await finishTurn($)
    await w.clock.advance(30 * MINUTE)
    await typed($, 'after 30 minutes')
    await w.clock.advance(2 * HOUR)
    w.tokens = 50_000
    await typed($, 'small context')
    w.tokens = 250_000
    await $.prompt.submit({ text: 'from the queue', wait: false, turnId: 't9', origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'job done', wait: false, origin: { kind: 'task-notification' } })
    expect(w.asked).toEqual([])
    expect(w.submits.length).toBe(5)
  })

  test('a subagent turn does not restart the main session pause', async ($, on) => {
    const w = world(on)
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    await finishTurn($, 'agent-1')
    await typed($, 'go on')
    expect(w.asked.length).toBe(1)
  })

  test('"New session" without a ready summary: from the condensed transcript, note saved, then /clear', async ($, on) => {
    const w = world(on)
    w.answer = NEW_SESSION
    w.forkFails = true
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    const said = await typed($, 'now do Y')
    expect(said.drop ?? '').toMatch(/^Handoff: writing the summary/)
    expect(w.order).toEqual(['fork'])
    await flush(w.clock)
    expect(w.order).toEqual(['fork', 'complete', 'write', 'clear', 'submit'])
    expect(appendedText(w)).toMatch(/^Handoff from the previous session \(abcdef12\)[\s\S]*X \(condensed\)$/)
    expect(w.submits.map(one => one.text)).toEqual(['now do Y'])
    expect(w.completes[0] ?? '').toMatch(/<transcript>\nUSER: do X/)
    // The engine resolves the path before the hooks below it: on Windows, with backslashes.
    expect(w.writes[0]?.path ?? '').toMatch(/^C:[\\/]Profiles[\\/]user[\\/]\.claude[\\/]handoffs[\\/]2026-10-03_1400_abcdef12\.md$/)
    expect(w.writes[0]?.text ?? '').toMatch(/claude --resume abcdef12-3456-7890-abcd-ef1234567890/)
    expect(w.writes[0]?.text ?? '').toMatch(/X \(condensed\)\n$/)
  })

  test('note not loaded: the prompt and the note land in the box, with the reason', async ($, on) => {
    const w = world(on)
    refuseAppend(on)
    w.answer = NEW_SESSION
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    await typed($, 'now do Y')
    await flush(w.clock)
    expect(w.fills.length).toBe(1)
    expect(w.fills[0] ?? '').toMatch(
      /^now do Y\n\nHandoff from the previous session \(abcdef12\), also saved in C:\/Profiles\/user\/\.claude\/handoffs\/2026-10-03_1400_abcdef12\.md\. /,
    )
    expect(w.fills[0] ?? '').toMatch(/X \(fork\)$/)
    expect(w.toasts.some(text => /the note did not enter the session \(/.test(text))).toBe(true)
    expect(w.submits).toEqual([])
  })

  test('Esc on the dialog: the prompt goes back to the box, then Enter passes without a question', async ($, on) => {
    const w = world(on)
    w.answer = undefined
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    const said = await typed($, 'something')
    expect(said.drop ?? '').toMatch(/back in the box/)
    await flush(w.clock)
    expect(w.fills).toEqual(['something'])
    const again = await typed($, 'something')
    expect(again.drop).toBeUndefined()
    expect(w.asked.length).toBe(1)
  })

  test('a failed summary does not /clear and gives the prompt back', async ($, on) => {
    const w = world(on)
    w.answer = NEW_SESSION
    w.forkFails = true
    w.completeFails = true
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    await typed($, 'now do Y')
    await flush(w.clock)
    expect(w.order).toEqual(['fork', 'complete'])
    expect(w.fills).toEqual(['now do Y'])
    expect(w.toasts.some(text => /no summary came out/.test(text))).toBe(true)
  })

  test('a prompt typed while the handoff works is held', async ($, on) => {
    const w = world(on)
    w.answer = NEW_SESSION
    w.forkFails = true
    w.completeDelayMs = MINUTE
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    await typed($, 'now do Y')
    await w.clock.settle()
    const said = await typed($, 'one more thing')
    expect(said.drop ?? '').toMatch(/^Handoff in progress/)
    await w.clock.advance(MINUTE)
    await flush(w.clock)
    expect(w.order.filter(step => step === 'clear').length).toBe(1)
    expect(w.fills).toEqual(['one more thing'])
    expect(w.submits.map(one => one.text)).toEqual(['now do Y'])
    expect(appendedText(w)).toMatch(/^Handoff from the previous session/)
  })
})

describe('the summary precomputed at 55 minutes', () => {
  test('at 55 minutes it writes it through a fork; the fork keeps the cache, so at 1 h 10 it does not ask', async ($, on) => {
    const w = world(on)
    await finishTurn($)
    await w.clock.advance(54 * MINUTE)
    expect(w.order).toEqual([])
    await w.clock.advance(MINUTE)
    expect(w.forkMinutes).toEqual([55])
    await w.clock.advance(15 * MINUTE)
    const said = await typed($, 'go on')
    expect(said.drop).toBeUndefined()
    expect(w.asked).toEqual([])
    expect(w.submits.map(one => one.text)).toEqual(['go on'])
  })

  test('after 1 h 56 it asks with the summary ready; the new session does not call the model again', async ($, on) => {
    const w = world(on)
    w.answer = NEW_SESSION
    await finishTurn($)
    await w.clock.advance(HOUR + 56 * MINUTE)
    const said = await typed($, 'now do Y')
    expect(w.asked[0] ?? '').toMatch(/^Paused for 1 h 56 min: .* The summary is already written\. Start/)
    expect(said.drop ?? '').toMatch(/^Handoff: the summary is ready/)
    await flush(w.clock)
    expect(w.order).toEqual(['fork', 'write', 'clear', 'submit'])
    expect(w.forkMinutes).toEqual([55])
    expect(appendedText(w)).toMatch(/^Handoff from the previous session[\s\S]*X \(fork\)$/)
    expect(w.submits.map(one => one.text)).toEqual(['now do Y'])
  })

  test('/handoff with the summary ready does not call the model again', async ($, on) => {
    const w = world(on)
    await finishTurn($)
    await w.clock.advance(HOUR + 10 * MINUTE)
    const said = await handoffCommand($, '')
    expect(said.text).toBe('the summary is ready; /clear and the new session.')
    await flush(w.clock)
    expect(w.order).toEqual(['fork', 'write', 'clear'])
    expect(w.forkMinutes).toEqual([55])
  })

  test('a turn before 55 minutes moves the precompute to 55 minutes after it', async ($, on) => {
    const w = world(on)
    await finishTurn($)
    await w.clock.advance(50 * MINUTE)
    await $.turn.start({ text: 'one more thing', turnId: 't2' })
    await w.clock.advance(10 * MINUTE)
    expect(w.order).toEqual([])
    await finishTurn($)
    await w.clock.advance(54 * MINUTE)
    expect(w.order).toEqual([])
    await w.clock.advance(MINUTE)
    expect(w.forkMinutes).toEqual([115])
  })

  test('no fork: context under 100k; late timer (the machine slept), then a summary from the transcript', async ($, on) => {
    const w = world(on)
    w.tokens = 50_000
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    expect(w.order).toEqual([])
    w.tokens = 250_000
    w.answer = NEW_SESSION
    w.usageDelayMs = 10 * MINUTE
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    expect(w.order).toEqual([])
    w.usageDelayMs = 0
    await typed($, 'now do Y')
    await flush(w.clock)
    expect(w.order).toEqual(['complete', 'write', 'clear', 'submit'])
  })

  test('a fork that finds the cache cold does not move the cache hour and stops the precompute', async ($, on) => {
    const w = world(on)
    w.forkCold = true
    await finishTurn($)
    await w.clock.advance(HOUR + 5 * MINUTE)
    await typed($, 'go on')
    expect(w.asked[0] ?? '').toMatch(/^Paused for 1 h 5 min: .*The summary is already written/)
    await finishTurn($)
    await w.clock.advance(2 * HOUR)
    expect(w.forkMinutes).toEqual([55])
  })
})

describe('/handoff', () => {
  test('warm (short pause) asks for the summary through a fork; the argument goes with the note', async ($, on) => {
    const w = world(on)
    await finishTurn($)
    await w.clock.advance(10 * MINUTE)
    const said = await handoffCommand($, ' continue with Z ')
    expect(said.text ?? '').toMatch(/^writing the summary/)
    await flush(w.clock)
    expect(w.order).toEqual(['fork', 'write', 'clear', 'submit'])
    expect(w.submits.map(one => one.text)).toEqual(['continue with Z'])
    expect(appendedText(w)).toMatch(/^Handoff from the previous session[\s\S]*X \(fork\)$/)
  })

  test('without an argument: only the note; a second /handoff while the first works is refused', async ($, on) => {
    const w = world(on)
    await finishTurn($)
    await handoffCommand($, '')
    const again = await handoffCommand($, '')
    expect(again.text).toBe('already in progress.')
    await flush(w.clock)
    expect(w.order).toEqual(['fork', 'write', 'clear'])
    expect(appendedText(w)).toMatch(/^Handoff from the previous session/)
    expect(w.toasts.some(text => /the summary is loaded/.test(text))).toBe(true)
  })
})
