import { expect, mock, test } from 'claude-code/testing'

const DIR = 'C:/U/.claude/session-status'

// An in-memory disk; on Windows the engine hands out paths with backslashes.
function memoryDisk(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const disk = new Map<string, string>()
  const k = (p: string) => p.replace(/\\/g, '/')
  on('fs.write', ($, e) => {
    disk.set(k(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const t = disk.get(k(e.path))
    return t === undefined ? { deny: 'ENOENT' } : { value: t }
  })
  on('fs.list', ($, e) => ({
    value: [...disk.keys()]
      .filter(c => c.startsWith(`${k(e.path)}/`))
      .map(c => ({ name: c.slice(k(e.path).length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  return disk
}

test('sees the neighbour session in the same folder and warns on the same file', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\U' })
  const session = mock.session(on)
  const disk = memoryDisk(on)
  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: 'D:\\repo' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  const now = clock.now()
  const neighbour = { id: 'other', root: 'd:/repo', state: 'working', task: 'refactor the parser', lastAction: 'Edit x', files: { 'd:/repo/readme.md': now }, seenAt: now, changedAt: now }
  disk.set(`${DIR}/other.json`, JSON.stringify(neighbour))
  disk.set(`${DIR}/dead.json`, JSON.stringify({ ...neighbour, id: 'dead', task: 'closed one', seenAt: now - 10 * 60_000 }))
  disk.set(`${DIR}/far.json`, JSON.stringify({ ...neighbour, id: 'far', root: 'd:/other-project', state: 'waiting', task: 'write the docs' }))

  await $.session.start({ cwd: 'D:\\repo', surface: 'terminal', isInteractive: true })

  const listed = await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(listed.text).toContain('refactor the parser')
  expect(listed.text).toContain('write the docs')
  expect(listed.text).not.toContain('closed one')

  const strip = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } })
  expect(await strip.find({ text: /refactor the parser/ })).toBeDefined()
  expect(await strip.find({ text: /1 session in another folder is waiting for you/ })).toBeDefined()

  await $.prompt.submit({ text: 'build the sessions mod', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: 'D:\\repo\\README.md', old_string: 'a', new_string: 'b' })
  const me = JSON.parse(disk.get(`${DIR}/me.json`) ?? '{}')
  expect(me.task).toBe('build the sessions mod')
  expect(me.files['d:/repo/readme.md']).toBe(now)
  expect(JSON.stringify(session.appended())).toContain('refactor the parser')

  await $.tool.call({ tool: 'Edit', file_path: 'D:\\repo\\README.md', old_string: 'b', new_string: 'c' })
  expect(JSON.stringify(session.appended()).split('[sessions]').length).toBe(2) // a single warning
})

test('after /clear and then /resume the session stays alive under the new id', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\U' })
  const disk = memoryDisk(on)
  let id = 'a'
  on('session.id', () => ({ value: id }))
  on('session.root', () => ({ value: 'D:\\repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const file = (s: string) => JSON.parse(disk.get(`${DIR}/${s}.json`) ?? '{}') as { ended?: boolean }

  await $.session.start({ cwd: 'D:\\repo', surface: 'terminal', isInteractive: true })
  // Regression: /clear, /resume to the old conversation, /clear again; after /resume the mod used to go silent.
  for (const [reason, nextId] of [['clear', 'b'], ['resume', 'a'], ['clear', 'c']] as const) {
    const previous = id
    await $.session.end({ reason, sessionId: previous, resume: { id: previous } })
    id = nextId
    await clock.advance(60_000)
    expect(file(previous).ended).toBe(nextId === previous ? undefined : true)
    expect(file(id).ended).toBeUndefined()
  }

  await $.session.end({ reason: 'prompt_input_exit', sessionId: id, resume: { id } })
  await clock.advance(60_000)
  expect(file(id).ended).toBe(true) // on exit it stays ended
})
