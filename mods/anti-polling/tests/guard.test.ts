import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { checkKey, isOnlyWaiting } from '../hooks/rules.ts'

// The simulated engine: every command "runs"; `readOnly` says what the core would
// mark as read-only. Returns the list of commands that actually got to run.
function shell(on: On, readOnly: (command: string) => boolean = () => false): string[] {
  const ran: string[] = []
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, ($, e) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return { deny: 'unexpected' }
    ran.push(e.command)
    const result = { stdout: '', stderr: '', interrupted: false }
    return readOnly(e.command) ? { result, text: 'ok', isReadOnly: true } : { result, text: 'ok' }
  })
  return ran
}

const bash = (command: string) => ({ tool: 'Bash', command }) as const

describe('rules', () => {
  test('what "only waiting" means', () => {
    expect(isOnlyWaiting('sleep 90 && echo checkpoint')).toBe(true)
    expect(isOnlyWaiting('sleep 30')).toBe(true)
    expect(isOnlyWaiting('Start-Sleep -Seconds 30')).toBe(true)
    expect(isOnlyWaiting('Start-Sleep 5 | Out-Null')).toBe(true)
    expect(isOnlyWaiting('true')).toBe(true)
    expect(isOnlyWaiting('timeout /t 30 /nobreak > nul')).toBe(true)
    expect(isOnlyWaiting('python -c "import time; time.sleep(30)"')).toBe(true)
    expect(isOnlyWaiting('sleep 5 2>&1; echo "done"')).toBe(true)

    expect(isOnlyWaiting('until [ -f done ]; do sleep 5; done')).toBe(false)
    expect(isOnlyWaiting('sleep 3 && curl -s localhost:8000/health')).toBe(false)
    expect(isOnlyWaiting('echo $PATH')).toBe(false)
    expect(isOnlyWaiting('echo hi > out.txt')).toBe(false)
    expect(isOnlyWaiting('npm test 2>&1')).toBe(false)
    expect(isOnlyWaiting(`python -c "import time; time.sleep(5); print(open('x').read())"`)).toBe(false)
    expect(isOnlyWaiting('date')).toBe(false)
    expect(isOnlyWaiting('')).toBe(false)
  })

  test('the sleep in front does not change the check', () => {
    expect(checkKey('sleep 60 && tail -c 3000 log')).toBe(checkKey('sleep 90; tail -c 3000 log'))
    expect(checkKey('tail -c 3000 log')).toBe('tail -c 3000 log')
    expect(checkKey('python run.py --seg 13')).not.toBe(checkKey('python run.py --seg 14'))
  })
})

describe('guard', () => {
  test('blocks a command that only waits, without running it', async ($, on) => {
    const ran = shell(on)
    const said = await $.tool.call(bash('sleep 90 && echo checkpoint'))
    expect(said.deny ?? '').toMatch(/^anti-polling: the command only waits/)
    expect(said.deny ?? '').toMatch(/run_in_background/)
    expect(ran).toEqual([])
  })

  test('in PowerShell it suggests the PowerShell loop', async ($, on) => {
    shell(on)
    const said = await $.tool.call({ tool: 'PowerShell', command: 'Start-Sleep -Seconds 60' })
    expect(said.deny ?? '').toMatch(/Start-Sleep 15 \}/)
  })

  test('lets a blocking loop and a short sleep followed by a check through', async ($, on) => {
    const ran = shell(on)
    expect((await $.tool.call(bash('until [ -f done ]; do sleep 5; done'))).deny).toBeUndefined()
    expect((await $.tool.call(bash('sleep 3 && curl -s localhost:8000/health'))).deny).toBeUndefined()
    expect(ran.length).toBe(2)
  })

  test('the 3rd identical check in a row is blocked', async ($, on) => {
    const ran = shell(on)
    const poll = bash('curl -s http://localhost:8188/history/454c6d6b')
    expect((await $.tool.call(poll)).deny).toBeUndefined()
    expect((await $.tool.call(poll)).deny).toBeUndefined()
    expect((await $.tool.call(poll)).deny ?? '').toMatch(/time #3/)
    expect((await $.tool.call(poll)).deny ?? '').toMatch(/time #3/)
    expect(ran.length).toBe(2)
  })

  test('a different sleep in front does not hide the same check', async ($, on) => {
    shell(on, () => true)
    expect((await $.tool.call(bash('sleep 30 && tail -c 3000 out.log'))).deny).toBeUndefined()
    expect((await $.tool.call(bash('sleep 60; tail -c 3000 out.log'))).deny).toBeUndefined()
    expect((await $.tool.call(bash('sleep 120 && tail -c 3000 out.log'))).deny ?? '').toMatch(/anti-polling/)
  })

  test('read-only checks do not reset each other', async ($, on) => {
    shell(on, () => true)
    expect((await $.tool.call(bash('tail -c 3000 out.log'))).deny).toBeUndefined()
    expect((await $.tool.call(bash('date -u'))).deny).toBeUndefined()
    expect((await $.tool.call(bash('tail -c 3000 out.log'))).deny).toBeUndefined()
    expect((await $.tool.call(bash('date -u'))).deny).toBeUndefined()
    expect((await $.tool.call(bash('tail -c 3000 out.log'))).deny ?? '').toMatch(/time #3/)
  })

  test('a command that changes something resets the streak (git status / add / commit)', async ($, on) => {
    const ran = shell(on, command => command === 'git status')
    for (const command of ['git status', 'git add a.ts', 'git status', 'git commit -m x', 'git status']) {
      expect((await $.tool.call(bash(command))).deny).toBeUndefined()
    }
    expect(ran.length).toBe(5)
  })

  test('an edit resets the streak (running the tests after each fix)', async ($, on) => {
    shell(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never, text: 'ok' }))
    const edit = { tool: 'Edit', file_path: 'D:/x.ts', old_string: 'a', new_string: 'b' } as const
    for (let i = 0; i < 4; i += 1) {
      expect((await $.tool.call(bash('npm test'))).deny).toBeUndefined()
      await $.tool.call(edit)
    }
  })

  test('a Read between checks does not reset the streak', async ($, on) => {
    shell(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: {} as never, text: 'ok' }))
    const read = { tool: 'Read', file_path: 'D:/log.txt' } as const
    await $.tool.call(bash('npm test'))
    await $.tool.call(read)
    await $.tool.call(bash('npm test'))
    await $.tool.call(read)
    expect((await $.tool.call(bash('npm test'))).deny ?? '').toMatch(/time #3/)
  })

  test('a long blocking wait (>= 5 min) does not count toward the streak', async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, async () => {
      await clock.sleep(6 * 60_000)
      return { result: { stdout: '', stderr: '', interrupted: false }, text: 'done' }
    })
    for (let i = 0; i < 3; i += 1) {
      const call = $.tool.call(bash('python render.py --wait'))
      await clock.advance(6 * 60_000)
      expect((await call).deny).toBeUndefined()
    }
  })

  test('a background command passes and resets the streak', async ($, on) => {
    const ran = shell(on)
    const poll = bash('ls out/')
    await $.tool.call(poll)
    await $.tool.call(poll)
    expect((await $.tool.call({ tool: 'Bash', command: 'sleep 600', run_in_background: true })).deny).toBeUndefined()
    expect((await $.tool.call(poll)).deny).toBeUndefined()
    expect(ran).toContain('sleep 600')
  })

  test('a new turn of the main session starts from zero', async ($, on) => {
    shell(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    const poll = bash('git log --oneline -3')
    await $.tool.call(poll)
    await $.tool.call(poll)
    await $.turn.start({ text: 'and now?', turnId: 't2' })
    expect((await $.tool.call(poll)).deny).toBeUndefined()
  })

  test('each subagent has its own streak, and its message does not suggest the background', async ($, on) => {
    shell(on)
    const poll = { tool: 'Bash', command: 'tail out.log', agentId: 'a1' } as const
    const other = { tool: 'Bash', command: 'tail out.log', agentId: 'a2' } as const
    await $.tool.call(poll)
    await $.tool.call(poll)
    expect((await $.tool.call(other)).deny).toBeUndefined()
    const said = await $.tool.call(poll)
    expect(said.deny ?? '').toMatch(/time #3/)
    expect(said.deny ?? '').not.toMatch(/run_in_background/)
  })
})
