// When a Bash command breaks a Windows path. No side effects: register.ts uses
// it, the tests check it directly.

// A Windows path with backslashes: `D:\work`, `C:\\Users` or a UNC `\\server\share`.
const WINDOWS_PATH = /(^|[^\w])[A-Za-z]:\\|\\\\[\w.$-]+\\/

// The constructs through which backslashes no longer reach the program untouched:
// heredoc and here-string (even `<<'EOF'`), printf and echo -e.
const RISKY: readonly (readonly [string, RegExp])[] = [
  ['heredoc', /<<(<|[-~]?\s*\\?['"]?\w)/],
  ['printf', /(^|[\s;&|(`])printf\s/],
  ['echo -e', /(^|[\s;&|(`])echo\s+-[a-zA-Z]*e/],
]

// The risky construct in the command, when the command also has a Windows path; otherwise undefined.
export function riskyConstruct(command: string): string | undefined {
  if (!WINDOWS_PATH.test(command)) return undefined
  return RISKY.find(([, rule]) => rule.test(command))?.[0]
}
