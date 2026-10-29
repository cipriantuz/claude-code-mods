import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { riskyConstruct } from '../hooks/rules.ts'

// The simulated engine: every command "runs". Returns the list of commands that actually got to run.
function shell(on: On): string[] {
  const ran: string[] = []
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, ($, e) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return { deny: 'unexpected' }
    ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' }
  })
  return ran
}

const bash = (command: string) => ({ tool: 'Bash', command }) as const

describe('rules', () => {
  test('catches Windows paths in heredoc, here-string, printf and echo -e', () => {
    expect(riskyConstruct("python - <<'EOF'\np = r'D:\\work\\tools\\app'\nEOF")).toBe('heredoc')
    expect(riskyConstruct('cat > a.md <<EOF\nD:\\work\\x\nEOF')).toBe('heredoc')
    expect(riskyConstruct('python - <<"PY"\nopen("C:\\\\data\\\\user\\\\a.txt")\nPY')).toBe('heredoc')
    expect(riskyConstruct("python <<< \"print(r'D:\\work')\"")).toBe('heredoc')
    expect(riskyConstruct("printf 'D:\\\\work\\\\scripts\\\\sync' > msg.txt")).toBe('printf')
    expect(riskyConstruct('echo -e "share = \\\\fileserver\\share"')).toBe('echo -e')
  })

  test('lets paths with / and commands without heredoc, printf or echo -e through', () => {
    expect(riskyConstruct("python - <<'EOF'\np = 'D:/work/tools/app'\nEOF")).toBeUndefined()
    expect(riskyConstruct("cat <<'EOF'\nno paths\nEOF")).toBeUndefined()
    expect(riskyConstruct('git -C "D:\\work" status --short')).toBeUndefined()
    expect(riskyConstruct('python /d/work/tools/app/main.py status')).toBeUndefined()
    expect(riskyConstruct("printf '%s\\n' done")).toBeUndefined()
    expect(riskyConstruct('echo D:\\work')).toBeUndefined()
    expect(riskyConstruct('')).toBeUndefined()
  })
})

describe('guard', () => {
  test('blocks a heredoc with a Windows path, without running it', async ($, on) => {
    const ran = shell(on)
    const said = await $.tool.call(bash("python - <<'EOF'\nopen(r'D:\\work\\tools\\x.txt')\nEOF"))
    expect(said.deny ?? '').toMatch(/^windows-paths: .*heredoc/)
    expect(said.deny ?? '').toMatch(/Write/)
    expect(ran).toEqual([])
  })

  test('lets an ordinary command run', async ($, on) => {
    const ran = shell(on)
    expect((await $.tool.call(bash('git -C D:/work status --short'))).deny).toBeUndefined()
    expect(ran).toEqual(['git -C D:/work status --short'])
  })

  test('does not touch PowerShell', async ($, on) => {
    const ran = shell(on)
    const command = "@'\nD:\\work\\tools\n'@ | Set-Content a.txt"
    expect((await $.tool.call({ tool: 'PowerShell', command })).deny).toBeUndefined()
    expect(ran).toEqual([command])
  })

  test('applies in subagents too', async ($, on) => {
    shell(on)
    const said = await $.tool.call({ tool: 'Bash', command: "printf 'D:\\\\work\\\\x' > m.txt", agentId: 'a1' })
    expect(said.deny ?? '').toMatch(/^windows-paths: .*printf/)
  })
})
