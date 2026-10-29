import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  CONDENSED_SYSTEM,
  NEW_SESSION,
  NOTE_REQUEST,
  STAY,
  condense,
  framed,
  noteFile,
  notePath,
  question,
} from './note.ts'

// Handoff. In one measured week of the author's sessions, 40 resumes after a pause
// of more than an hour each re-wrote ~290k tokens into the cache (30% of all
// cache_creation), because the prompt cache lives for one hour. On the first prompt
// after such a pause, with a large context, it asks whether to start a new session
// with a summary; /handoff does the same at any time.
// At 55 minutes of pause the summary is written ahead of time, through a fork, while
// the cache is still warm. The fork reads the context from the cache, so the cache
// lives one more hour from then: a resume up to ~1 h 55 min re-writes nothing and
// does not ask.

// How long the cache lives after the last read: after that, continuing re-writes the whole context.
const PAUSE_MS = 60 * 60_000
// Up to this the cache is surely warm: the summary is precomputed then, and below this
// an on-demand summary comes through a fork; above it, from a condensed transcript, so
// that the summary itself does not re-write the cache.
const WARM_MS = 55 * 60_000
// Below this much context, a new session does not gain enough.
const MIN_CONTEXT = 100_000

type State = {
  // When the last turn of the main session ended; undefined while a turn runs or while unknown.
  lastTurnAt: number | undefined
  // The last read of the context from the cache (turn or fork): the cache hour runs from then.
  lastReadAt: number | undefined
  // The summary precomputed for the current pause, and its writing while in progress.
  ready: string | undefined
  precomputing: Promise<void> | undefined
  // The precompute of the current pause; one from a past pause exits on its own (lastTurnAt changed).
  timer: Timer | undefined
  // The fork re-wrote the context into the cache (5-minute cache, changed MCP tools,
  // /model): no precompute in this session, so the re-write is not paid on every pause.
  isPrecomputeOff: boolean
  // After the user closed the dialog, their next prompt goes through without a question.
  skipOnce: boolean
  isBusy: boolean
}

function forget(state: State): void {
  state.lastTurnAt = undefined
  state.lastReadAt = undefined
  state.ready = undefined
}

async function sinceRead($: EngineInterface, state: State): Promise<number> {
  if (state.lastReadAt === undefined) return Number.POSITIVE_INFINITY
  return (await $.clock.now()) - state.lastReadAt
}

// Puts the text back in the prompt box after the current dispatch has finished.
function giveBack($: EngineInterface, text: string): void {
  $.clock.after(0, () => void $.prompt.fill({ text }).catch(() => undefined))
}

function fail($: EngineInterface, state: State, prompt: string, why: string): void {
  $.ui.toast(prompt === '' ? `handoff: ${why}` : `handoff: ${why}; the prompt is back in the box`)
  if (prompt === '') return
  state.skipOnce = true
  giveBack($, prompt)
}

async function writeNote($: EngineInterface, isWarm: boolean): Promise<string | undefined> {
  if (isWarm) {
    const reply = await $.model.fork({ prompt: NOTE_REQUEST })
    return reply.isAnswered ? reply.text.trim() : undefined
  }
  const transcript = condense(await $.session.messages())
  if (transcript === '') return undefined
  const reply = await $.model.complete({
    model: await $.session.model(),
    system: CONDENSED_SYSTEM,
    prompt: `${NOTE_REQUEST}\n\n<transcript>\n${transcript}\n</transcript>`,
    maxTokens: 4_000,
    effort: 'medium',
    timeoutMs: 300_000,
  })
  return reply.isAnswered ? reply.text.trim() : undefined
}

// The summary ahead of time, at 55 minutes of pause, while the cache is still warm.
async function precompute($: EngineInterface, state: State, turnAt: number): Promise<void> {
  if (state.isPrecomputeOff || state.isBusy || state.lastTurnAt !== turnAt) return
  if (((await $.session.usage()).context.tokens ?? 0) < MIN_CONTEXT) return
  const startedAt = await $.clock.now()
  // The timer fired late (the machine slept): the cache may be cold, and the fork would re-write it.
  if (startedAt - turnAt > WARM_MS + 3 * 60_000 || state.lastTurnAt !== turnAt) return
  const reply = await $.model.fork({ prompt: NOTE_REQUEST })
  if (!reply.isAnswered || state.lastTurnAt !== turnAt) return
  // More written than read: the fork did not find the context in the cache.
  if (reply.usage.cache_creation_input_tokens > reply.usage.cache_read_input_tokens) state.isPrecomputeOff = true
  else state.lastReadAt = startedAt
  const text = reply.text.trim()
  if (text !== '') state.ready = text
}

function schedule($: EngineInterface, state: State, turnAt: number): void {
  state.timer?.cancel()
  state.timer = $.clock.after(WARM_MS, () => {
    state.timer = undefined
    state.precomputing = precompute($, state, turnAt)
      .catch(() => undefined)
      .finally(() => {
        state.precomputing = undefined
      })
  })
}

// Summary -> file -> /clear -> the note in the new session -> the held prompt, if any.
async function handoff($: EngineInterface, state: State, prompt: string): Promise<void> {
  $.ui.status('handoff: writing the summary…')
  try {
    await state.precomputing
    const sessionId = await $.session.id()
    const isWarm = (await sinceRead($, state)) < WARM_MS
    const note = state.ready ?? (await writeNote($, isWarm).catch(() => undefined))
    if (note === undefined || note === '') return fail($, state, prompt, 'no summary came out, the session is unchanged')
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const path = home === undefined ? undefined : notePath(`${home}/.claude/handoffs`, await $.clock.now(), sessionId)
    const isSaved = path !== undefined && (await $.fs.write(path, noteFile(note, sessionId)).then(() => true, () => false))
    const savedAt = isSaved ? path : undefined
    const isCleared = await $.command.run({ command: 'clear' }).then(() => true, () => false)
    if (!isCleared) return fail($, state, prompt, '/clear failed, the session is unchanged')
    forget(state)
    const text = framed(note, sessionId, savedAt)
    const appended = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
    if (appended.deny !== undefined) {
      // The session is already new: the note goes along with the prompt, from the box.
      $.ui.toast(`handoff: the note did not enter the session (${appended.deny}); it is in the box, next to the prompt`)
      giveBack($, `${prompt}\n\n${text}`.trim())
      return
    }
    $.ui.log(`handoff: new session with the summary of session ${sessionId.slice(0, 8)}${savedAt === undefined ? '' : ` (${savedAt})`}`)
    if (prompt === '') {
      $.ui.toast('handoff: the summary is loaded; type what comes next')
      return
    }
    await $.prompt.submit({ text: prompt, asUser: true }).catch(() => giveBack($, prompt))
  } catch {
    fail($, state, prompt, 'unexpected error')
  } finally {
    $.ui.status(undefined)
  }
}

function start($: EngineInterface, state: State, prompt: string): void {
  state.isBusy = true
  $.clock.after(0, () => {
    void handoff($, state, prompt).finally(() => {
      state.isBusy = false
    })
  })
}

export const register: Register = on => {
  const state: State = {
    lastTurnAt: undefined,
    lastReadAt: undefined,
    ready: undefined,
    precomputing: undefined,
    timer: undefined,
    isPrecomputeOff: false,
    skipOnce: false,
    isBusy: false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'New session with a summary of this one (note saved, /clear, note loaded); the argument becomes the first prompt',
      argumentHint: '[first prompt]',
    })
    return next(e)
  })

  // A new turn of the main session: the pause is over, a ready summary goes stale.
  on('turn.start', ($, e, next) => {
    state.lastTurnAt = undefined
    state.ready = undefined
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      state.lastTurnAt = now
      state.lastReadAt = now
      state.ready = undefined
      schedule($, state, now)
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') forget(state)
    return next(e)
  })

  // The engine shows the command's text after the plugin name ("handoff: …").
  on('command.run', { command: 'handoff' }, async ($, e) => {
    if (state.isBusy) return { text: 'already in progress.' }
    const isReady = state.ready !== undefined
    start($, state, e.args.trim())
    return { text: isReady ? 'the summary is ready; /clear and the new session.' : 'writing the summary, then /clear.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.turnId !== undefined) return next(e)
    if (state.isBusy) {
      giveBack($, e.text)
      return { drop: 'Handoff in progress: the prompt is back in the box; send it once the new session starts.' }
    }
    if (state.skipOnce) {
      state.skipOnce = false
      return next(e)
    }
    if (e.attachments !== undefined) return next(e)
    const turnAt = state.lastTurnAt
    if (turnAt === undefined || (await sinceRead($, state)) < PAUSE_MS) return next(e)
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (tokens < MIN_CONTEXT) return next(e)
    const isReady = state.ready !== undefined
    const idleMs = (await $.clock.now()) - turnAt
    const answer = await $.ui
      .ask(question(idleMs, tokens, isReady), { header: 'Handoff', options: [NEW_SESSION, STAY] })
      .catch(() => undefined)
    if (answer === undefined) {
      state.skipOnce = true
      giveBack($, e.text)
      return { drop: 'Handoff: the prompt is back in the box. Enter = continue here; /handoff = new session with a summary.' }
    }
    if (answer !== NEW_SESSION) return next(e)
    start($, state, e.text)
    return {
      drop: isReady
        ? 'Handoff: the summary is ready; /clear, then the prompt goes to the new session.'
        : 'Handoff: writing the summary, then /clear, then the prompt goes to the new session.',
    }
  })
}
