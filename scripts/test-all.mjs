// Runs every test in the repository: each mod's TypeScript tests through the Claude Code
// mod test kit (`claude plugin test`), then the Python tests of the approval-channel
// dispatcher (`python -m pytest`). Exits 1 if anything fails. No network needed.
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const mods = readdirSync(join(root, 'mods')).filter(name => statSync(join(root, 'mods', name)).isDirectory()).sort()
const python = process.env.PYTHON || 'python'
const shell = process.platform === 'win32'

const steps = [
  ...mods.map(mod => ({ name: mod, command: 'claude', args: ['plugin', 'test', join('mods', mod)] })),
  { name: 'approval-channel (python)', command: python, args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', join('mods', 'approval-channel', 'bin')] },
]

const failed = []
for (const step of steps) {
  console.log(`\n=== ${step.name}`)
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit', shell })
  if (result.status !== 0) failed.push(step.name)
}
console.log(failed.length === 0 ? `\nAll ${steps.length} suites passed.` : `\nFailed: ${failed.join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
