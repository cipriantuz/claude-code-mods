import type { EngineInterface, Register } from 'claude-code'

// The session's link to the user's phone, over ntfy. The `bin/dispatcher.py listen`
// process (run it under any process supervisor) receives what the user writes and puts
// it in ~/.claude/approval-channel/inbox/<sid>.jsonl; this mod hands it to the session as
// the user's prompt and sends the turn's answer back. The `send` tool lets the model ask
// for a decision or an approval, with an optional file attached.
// Nothing here calls a model.

const READ_MS = 5_000
const SEND_TIMEOUT_MS = 300_000 // uploading an attachment can take a while
const PREFIX = '[from phone] '
const MAX_MESSAGE = 4000 // dispatcher.py cuts at 3500; this only keeps under the Windows command-line limit
const MAX_PER_PROMPT = 10 // messages joined into one prompt
const MAX_PROMPT = 8000

const DESCRIPTION = [
  "Sends a message to the user's phone (ntfy), with an optional file attached (up to the ntfy server's attachment limit, 2 MB on the free public server).",
  'Use it when you need a decision or an approval from the user and they may be away from the computer, or when something long they are waiting for has finished.',
  'After asking a question here, end the turn and do not use AskUserQuestion: the answer arrives as a new prompt that starts with "[from phone]".',
  'When the current prompt came from the phone, your final answer is sent to the phone automatically, so do not also send it with this tool.',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'The text for the user, short, with the question first.' },
    file: {
      type: 'string',
      description: 'Absolute path, optional. Sent as an attachment only if it fits the ntfy attachment limit.',
    },
    await_reply: {
      type: 'boolean',
      description: 'true (default) when you expect an answer: a reply of theirs without a session number then comes here.',
    },
    priority: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: '2 = silent (e.g. a report that something is fixed), 4 = urgent; default 3',
    },
  },
  required: ['message'],
} as const

// Module state (a reload starts over; the delivery cursor lives on disk).
const st = {
  dir: '',
  script: '',
  python: 'python',
  number: '',
  pending: false, // a phone prompt is waiting for its turn to start
  fromPhone: false, // the current turn started from the phone
  sentThisTurn: false, // the model already used the tool in this turn
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function dispatch($: EngineInterface, args: string[]): Promise<string> {
  const sid = await $.session.id()
  try {
    const r = await $.process.run([st.python, st.script, 'send', `--session=${sid}`, ...args], {
      timeoutMs: SEND_TIMEOUT_MS,
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    const last = (r.stdout.trim() || r.stderr.trim()).split('\n').pop()?.trim() ?? ''
    if (r.exitCode === 0) return last
    return last.startsWith('error') ? last : `error: ${last || `dispatcher.py exited with ${r.exitCode}`}`
  } catch (err) {
    return `error: ${errorText(err)}`
  }
}

async function showNumber($: EngineInterface, sid: string) {
  const text = await $.fs.read(`${st.dir}/registry.json`).catch(() => null)
  let number = ''
  if (text !== null) {
    try {
      const reg = JSON.parse(text) as Record<string, { sid?: string }>
      number = Object.keys(reg).find(k => reg[k]?.sid === sid) ?? ''
    } catch {
      return // the registry is written atomically; a broken JSON is left for next time
    }
  }
  if (number === st.number) return
  st.number = number
  $.ui.status(number === '' ? undefined : `phone #${number}`)
}

// The new lines (at most MAX_PER_PROMPT) of the inbox; null when there is nothing new.
async function newLines($: EngineInterface, file: string, cursorFile: string) {
  const text = await $.fs.read(file).catch(() => null)
  if (text === null) return null
  // whole lines only: the writer may be in the middle of a line
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').slice(0, -1)
  const delivered = Number((await $.fs.read(cursorFile).catch(() => '0')).trim()) || 0
  if (lines.length <= delivered) return null
  const fresh = lines.slice(delivered, delivered + MAX_PER_PROMPT)
  const texts: string[] = []
  for (const line of fresh) {
    try {
      const m = JSON.parse(line) as { text?: unknown }
      if (typeof m.text === 'string' && m.text.trim() !== '') texts.push(m.text.trim())
    } catch {
      // broken line: skip it
    }
  }
  return { cursor: delivered + fresh.length, texts }
}

async function readInbox($: EngineInterface) {
  const sid = await $.session.id() // the id changes after /clear
  await showNumber($, sid)
  if (st.pending) return
  const cursorFile = `${st.dir}/delivered/${sid}.txt`
  const n = await newLines($, `${st.dir}/inbox/${sid}.jsonl`, cursorFile)
  if (n === null) return
  // the cursor first, so a prompt that fails to start is not repeated on every read
  await $.fs.write(cursorFile, String(n.cursor))
  if (n.texts.length === 0) return
  st.pending = true
  void $.prompt
    .submit({ text: (PREFIX + n.texts.join('\n\n')).slice(0, MAX_PROMPT), asUser: true })
    .catch(err => $.ui.log(`the phone message did not enter the session: ${errorText(err)}`))
    .finally(() => {
      st.pending = false
    })
}

async function answerOnPhone($: EngineInterface, text: string) {
  const result = await dispatch($, [`--message=${text.slice(0, MAX_MESSAGE)}`, '--title=reply', '--request'])
  if (result.startsWith('error')) $.ui.log(`the answer did not reach the phone: ${result}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (!e.isInteractive) return r // `claude -p` has no number in the registry and nobody to write to it
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    st.dir = `${home.replace(/\\/g, '/')}/.claude/approval-channel`
    st.script = `${$.plugin.root.replace(/\\/g, '/')}/bin/dispatcher.py`
    st.python = (await $.env.get('APPROVAL_PYTHON')) ?? 'python'
    await $.tool.register({ name: 'send', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    $.clock.every(READ_MS, () => void readInbox($))
    return r
  })

  // a prompt submitted from a timer does not pass through this mod's own hooks (re-entry), so it is recognized by its prefix
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      st.fromPhone = e.text.startsWith(PREFIX)
      st.sentThisTurn = false
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    const text = e.answer.trim() || (e.reason === 'answer' ? '' : `(turn stopped: ${e.reason})`)
    const toSend = st.fromPhone && !st.sentThisTurn && e.reason !== 'aborted' && text !== ''
    st.fromPhone = false
    // after the turn has ended: the transcript does not wait for ntfy
    if (toSend) $.clock.after(0, () => void answerOnPhone($, text))
    return r
  })

  on('tool.call', { tool: 'mcp__approval-channel__send' }, async ($, e) => {
    const input = e as unknown as { message?: unknown; file?: unknown; await_reply?: unknown; priority?: unknown }
    const message = typeof input.message === 'string' ? input.message.trim() : ''
    if (message === '') return { result: 'error: the message is missing' }
    // the --x=value form: a text that starts with "-" is never taken for an option
    const args = [`--message=${message.slice(0, MAX_MESSAGE)}`]
    if (typeof input.file === 'string' && input.file.trim() !== '') args.push(`--file=${input.file.trim()}`)
    if (input.await_reply !== false) args.push('--request')
    const p = input.priority
    if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 5) args.push(`--priority=${p}`)
    const result = await dispatch($, args)
    if (!result.startsWith('error')) st.sentThisTurn = true
    return { result }
  }).catch(($, e, next) => ({ result: `error: ${next.error?.message ?? 'the tool failed'}` }))
}
