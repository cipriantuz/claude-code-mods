import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionStatus, State } from '../types'

// Every interactive session writes its status to ~/.claude/session-status/<id>.json
// and reads the others'; sessions in the same folder see each other in the strip
// above the prompt. Nothing here calls a model.

const others = atom({ plugin: 'sessions', key: 'others' } as const, [] as SessionStatus[])

const ALIVE_MS = 3 * 60_000 // no heartbeat for 3 min = session closed
const EDIT_MS = 6 * 3600_000 // how long a touched file counts as "theirs"
const HEARTBEAT_MS = 60_000
const READ_MS = 15_000
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const QUESTIONS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const SIGN: Record<State, string> = { working: '●', waiting: '◆', done: '✓' }
const COLOR: Record<State, string> = { working: 'yellow', waiting: 'red', done: 'green' }

// Module state (a reload starts over; session.start rebuilds it from the file).
const st = {
  dir: '',
  me: null as SessionStatus | null,
  latest: [] as SessionStatus[],
  warned: new Set<string>(),
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const short = (t: string, n: number) => {
  const line = (t.trim().split('\n')[0] ?? '').trim()
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}
const ago = (ms: number) => {
  const min = Math.round(ms / 60_000)
  return min < 1 ? 'now' : min < 60 ? `${min} min` : `${Math.round(min / 60)} h`
}

const describeAction = (tool: string, e: Record<string, unknown>) => {
  const path = e.file_path ?? e.notebook_path
  if (typeof path === 'string') return `${tool} ${baseName(path)}`
  if (tool === 'Bash' || tool === 'PowerShell') return `${tool}: ${short(String(e.command ?? ''), 40)}`
  if (tool === 'Agent') return `agent: ${short(String(e.description ?? ''), 40)}`
  return tool
}

async function save($: EngineInterface) {
  if (st.me === null || st.dir === '') return
  st.me.id = await $.session.id() // the id changes after /clear
  st.me.seenAt = await $.clock.now()
  await $.fs.write(`${st.dir}/${st.me.id}.json`, JSON.stringify(st.me))
}

async function setState($: EngineInterface, state: State, extra: Partial<SessionStatus> = {}) {
  if (st.me === null) return
  Object.assign(st.me, extra)
  if (st.me.state !== state) st.me.changedAt = await $.clock.now()
  st.me.state = state
  await save($)
}

async function fresh($: EngineInterface): Promise<SessionStatus> {
  const now = await $.clock.now()
  return {
    id: await $.session.id(),
    root: norm(await $.session.root()),
    state: 'done',
    task: '',
    lastAction: '',
    files: {},
    seenAt: now,
    changedAt: now,
  }
}

async function readOthers($: EngineInterface) {
  if (st.me === null) return
  const now = await $.clock.now()
  const entries = await $.fs.list(st.dir).catch(() => [])
  const alive: SessionStatus[] = []
  for (const f of entries) {
    if (!f.name.endsWith('.json') || f.name === `${st.me.id}.json`) continue
    if (f.mtimeMs > 0 && now - f.mtimeMs > 24 * 3600_000) continue // old ones are not opened at all
    const s = await $.fs
      .read(`${st.dir}/${f.name}`)
      .then(t => JSON.parse(t) as SessionStatus)
      .catch(() => null)
    if (s === null || s.ended === true || now - s.seenAt > ALIVE_MS) continue
    alive.push(s)
  }
  alive.sort((a, b) => a.root.localeCompare(b.root) || b.changedAt - a.changedAt)
  st.latest = alive
  await update($, others, () => alive)
}

async function begin($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  st.dir = `${home.replace(/\\/g, '/')}/.claude/session-status`
  const id = await $.session.id()
  const previous = await $.fs
    .read(`${st.dir}/${id}.json`)
    .then(t => JSON.parse(t) as SessionStatus)
    .catch(() => null)
  st.me = previous !== null && previous.ended !== true ? previous : await fresh($)
  await save($)
  await readOthers($)
}

async function end($: EngineInterface, sessionId: string, continues: boolean) {
  if (st.me === null || st.dir === '') return
  await $.fs.write(`${st.dir}/${sessionId}.json`, JSON.stringify({ ...st.me, id: sessionId, ended: true }))
  // after /clear and /resume the process goes on under another id, without session.start
  st.me = continues ? await fresh($) : null
}

async function checkFile($: EngineInterface, path: string, now: number) {
  const me = st.me
  if (me === null) return
  const p = norm(path)
  for (const s of st.latest) {
    const when = s.files[p]
    const key = `${s.id}|${p}`
    if (s.root !== me.root || when === undefined || now - when > EDIT_MS || st.warned.has(key)) continue
    st.warned.add(key)
    const text = `${baseName(path)} was also modified ${ago(now - when)} ago by another session open in this folder (task: "${s.task}").`
    $.ui.toast(`⚠ ${text}`, { timeoutMs: 10_000 })
    await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: `[sessions] ${text} When committing, stage only your own hunks.` }] } })
      .catch(() => undefined)
  }
  me.files[p] = now
  for (const [f, t] of Object.entries(me.files)) if (now - t > EDIT_MS) delete me.files[f]
}

async function list($: EngineInterface) {
  await readOthers($)
  const now = await $.clock.now()
  const all = st.me === null ? st.latest : [{ ...st.me, task: `${st.me.task} (this one)` }, ...st.latest]
  if (all.length === 0) return 'No open session.'
  const byRoot = new Map<string, SessionStatus[]>()
  for (const s of all) byRoot.set(s.root, [...(byRoot.get(s.root) ?? []), s])
  const lines: string[] = []
  for (const [root, group] of byRoot) {
    lines.push(root)
    for (const s of group) {
      lines.push(`  ${SIGN[s.state]} ${s.state} for ${ago(now - s.changedAt)} · "${s.task || '—'}"${s.lastAction ? ` · ${s.lastAction}` : ''}`)
    }
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (!e.isInteractive) return r // `claude -p` and the SDK do not show up in the list
    await begin($)
    await $.command.register({
      name: 'sessions',
      description: 'All open Claude Code sessions: what each one does and which ones are waiting for you',
    })
    $.clock.every(HEARTBEAT_MS, () => void save($))
    $.clock.every(READ_MS, () => void readOthers($))
    return r
  })

  on('session.end', async ($, e, next) => {
    await end($, e.sessionId, e.reason === 'clear' || e.reason === 'resume')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    const fromUser = kind === undefined || kind === 'composer' || kind === 'bridge'
    if (fromUser && !e.text.startsWith('/')) await setState($, 'working', { task: short(e.text, 80), lastAction: '' })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (st.me !== null && st.me.state !== 'working') await setState($, 'working')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await setState($, 'done')
    return r
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await setState($, 'waiting', { lastAction: `asks permission: ${e.tool_name}` })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (st.me === null) return next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const path = input.file_path ?? input.notebook_path
    if (EDITS.has(tool) && typeof path === 'string') await checkFile($, path, await $.clock.now())

    const asks = QUESTIONS.has(tool) && e.agentId === undefined
    await setState($, asks ? 'waiting' : 'working', { lastAction: asks ? 'asking you something' : describeAction(tool, input) })
    const r = await next(e)
    if (st.me !== null && st.me.state === 'waiting') await setState($, 'working')
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sessions' }, async $ => ({ text: await list($) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const me = st.me
    if (e.props.hasSurvey || me === null) return next(e)
    const all = await read($, others)
    const here = all.filter(s => s.root === me.root)
    const waiting = all.filter(s => s.root !== me.root && s.state === 'waiting').length
    if (here.length === 0 && waiting === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns - 2)
    const room = Math.max(1, e.props.maxRows - (waiting > 0 ? 1 : 0))
    const rows = here.slice(0, room).map(s => (
      <Text key={s.id}>
        <Text color={COLOR[s.state]}>{SIGN[s.state]}</Text>
        <Text dimColor>{short(` ${s.state} · "${s.task || '—'}"${s.lastAction ? ` · ${s.lastAction}` : ''} · ${ago(now - s.changedAt)}`, width)}</Text>
      </Text>
    ))
    const elsewhere = waiting === 1 ? 'session in another folder is waiting for you' : 'sessions in other folders are waiting for you'
    return (
      <Box flexDirection="column">
        {rows}
        {waiting > 0 ? <Text color="red">{`◆ ${waiting} ${elsewhere} (/sessions)`}</Text> : null}
      </Box>
    )
  })
}
