import type { Register } from 'claude-code'

import { riskyConstruct } from './rules.ts'

// Guard for Windows paths in the Bash tool. A heredoc (even `<<'EOF'`), printf or
// echo -e does not leave backslashes untouched: the `\t` in `D:\work\tools` becomes
// a TAB, `\\` becomes `\`. Files got corrupted this way four times in one week,
// although the pitfall was already written down in the agent's memory. Blocks the
// command before it runs, in the main session and in subagents. PowerShell is not
// touched: the `@'…'@` here-string keeps backslashes.

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const construct = riskyConstruct(e.command)
    if (construct === undefined) return next(e)
    $.ui.toast(`windows-paths: blocked a ${construct} with a Windows path`)
    return {
      deny: `windows-paths: the command puts a Windows path with backslashes into a ${construct}, and in the Bash tool backslashes do not arrive untouched, not even with <<'EOF' ("\\t" becomes a TAB, "\\\\" becomes "\\"). Write the file or script with Write and run it, or write the paths with / (D:/work/...). For a commit message: Write it to a file, then git commit -F.`,
    }
  })
}
