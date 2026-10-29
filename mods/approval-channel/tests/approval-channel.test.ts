import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const DIR = 'C:/U/.claude/approval-channel'
const TOOL = 'mcp__approval-channel__send'

// The in-memory disk, the processes run and the prompts submitted; on Windows the engine hands out paths with backslashes.
function world(on: On) {
  const disk = new Map<string, string>()
  const runs: string[][] = []
  const prompts: { text: string; asUser: boolean }[] = []
  const k = (p: string) => p.replace(/\\/g, '/')
  mock.env(on, { USERPROFILE: 'C:\\U' })
  on('fs.write', ($, e) => {
    disk.set(k(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const t = disk.get(k(e.path))
    return t === undefined ? { deny: 'ENOENT' } : { value: t }
  })
  on('session.id', () => ({ value: 'me' }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__approval-channel__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'sent to the phone as #3\n', stderr: '' } }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind === 'plugin') prompts.push({ text: e.text, asUser: e.origin.asUser === true })
    return { text: e.text }
  })
  return { disk, runs, prompts }
}

const turn = { durationMs: 1, isAborted: false } as const
const line = (id: string, text: string) => `${JSON.stringify({ id, ts: 1, text })}\n`

test('phone messages come in as a prompt, and the answer goes back', async ($, on) => {
  const clock = mock.clock(on)
  const { disk, runs, prompts } = world(on)
  disk.set(`${DIR}/registry.json`, JSON.stringify({ '3': { sid: 'me', task: 'Release notes', state: 'done' } }))
  disk.set(`${DIR}/inbox/me.jsonl`, `${line('a', 'yes, ship it')}${line('b', 'and fix the title')}{"id":"c","te`)

  await $.session.start({ cwd: 'D:\\repo', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)

  // the half-written line waits for next time
  expect(prompts).toEqual([{ text: '[from phone] yes, ship it\n\nand fix the title', asUser: true }])
  expect(disk.get(`${DIR}/delivered/me.txt`)).toBe('2')

  await $.turn.start({ text: prompts[0]?.text ?? '', turnId: 't1' })
  await $.turn.complete({ ...turn, answer: 'Shipped, title fixed.', reason: 'answer', turnId: 't1' })
  await clock.advance(1)
  expect(runs.at(-1)).toEqual([
    'python', expect.stringContaining('/bin/dispatcher.py'), 'send', '--session=me',
    '--message=Shipped, title fixed.', '--title=reply', '--request',
  ])

  // a prompt typed at the computer sends nothing to the phone
  const before = runs.length
  await $.turn.start({ text: 'something else', turnId: 't2' })
  await $.turn.complete({ ...turn, answer: 'Done.', reason: 'answer', turnId: 't2' })
  await clock.advance(1)
  expect(runs.length).toBe(before)

  // same cursor: nothing to deliver again until the line is complete
  await clock.advance(5_000)
  expect(prompts.length).toBe(1)
  disk.set(`${DIR}/inbox/me.jsonl`, `${disk.get(`${DIR}/inbox/me.jsonl`)}xt":"no, wait"}\n`)
  await clock.advance(5_000)
  expect(prompts.at(-1)?.text).toBe('[from phone] no, wait')
})

test('at most 10 messages in one prompt; the rest on the next read', async ($, on) => {
  const clock = mock.clock(on)
  const { disk, prompts } = world(on)
  disk.set(`${DIR}/inbox/me.jsonl`, Array.from({ length: 12 }, (_, i) => line(`m${i}`, `m${i}`)).join(''))
  await $.session.start({ cwd: 'D:\\repo', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  expect(prompts[0]?.text.split('\n\n').length).toBe(10)
  expect(disk.get(`${DIR}/delivered/me.txt`)).toBe('10')
  await clock.advance(5_000)
  expect(prompts[1]?.text).toBe('[from phone] m10\n\nm11')
})

test('the tool sends the question with the file; then the turn answer is not sent twice', async ($, on) => {
  const clock = mock.clock(on)
  const { disk, runs } = world(on)
  disk.set(`${DIR}/inbox/me.jsonl`, line('a', 'how does it look?'))

  await $.session.start({ cwd: 'D:\\repo', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  await $.turn.start({ text: '[from phone] how does it look?', turnId: 't1' })

  const r = await $.tool.call({ tool: TOOL, message: 'Approve this version?', file: 'D:\\repo\\out\\report.pdf' } as never)
  expect(JSON.stringify(r)).toContain('sent to the phone as #3')
  expect(runs.at(-1)).toEqual([
    'python', expect.stringContaining('/bin/dispatcher.py'), 'send', '--session=me',
    '--message=Approve this version?', '--file=D:\\repo\\out\\report.pdf', '--request',
  ])

  const before = runs.length
  await $.turn.complete({ ...turn, answer: 'I sent you the report.', reason: 'answer', turnId: 't1' })
  await clock.advance(1)
  expect(runs.length).toBe(before)
})

test('the tool passes the priority on only when it is between 1 and 5', async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: 'D:\\repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, message: 'The build is fixed.', await_reply: false, priority: 2 } as never)
  expect(runs.at(-1)).toEqual([
    'python', expect.stringContaining('/bin/dispatcher.py'), 'send', '--session=me',
    '--message=The build is fixed.', '--priority=2',
  ])
  await $.tool.call({ tool: TOOL, message: 'x', await_reply: false, priority: 9 } as never)
  expect(runs.at(-1)).toEqual(['python', expect.stringContaining('/bin/dispatcher.py'), 'send', '--session=me', '--message=x'])
})

test('an empty message is refused without running the dispatcher', async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: 'D:\\repo', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: TOOL, message: '   ' } as never)
  expect(JSON.stringify(r)).toContain('error: the message is missing')
  expect(runs).toEqual([])
})
