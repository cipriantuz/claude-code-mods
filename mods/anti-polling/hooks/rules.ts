// What "only waiting" means, and the key under which two checks count as the same
// command. No side effects: register.ts uses these, the tests check them directly.

// A segment that only sleeps (bash, PowerShell, cmd, inline Python).
const WAIT: readonly RegExp[] = [
  /^sleep\s+\d+(\.\d+)?[smhd]?$/i,
  /^start-sleep(\s+-(s|seconds|m|milliseconds))?\s+\d+(\.\d+)?$/i,
  /^timeout(\.exe)?\s+\/t\s+\d+(\s+\/nobreak)?$/i,
  /^ping(\.exe)?\s+(-n\s+\d+\s+)?(127\.0\.0\.1|localhost)(\s+-n\s+\d+)?$/i,
  /^\[(system\.)?threading\.thread\]::sleep\(\s*\d+\s*\)$/i,
  /^(python3?|py)(\.exe)?\s+-c\s+(["'])\s*import\s+time\s*;\s*time\.sleep\(\s*\d+(\.\d+)?\s*\)\s*;?\s*\3$/i,
]

// A segment that does nothing: `true`, `:`, an echo of literal text.
const NOOP: readonly RegExp[] = [
  /^(true|:)$/,
  /^out-null$/i,
  /^(echo|printf|write-host|write-output)(\s+[^$`%<>()]*)?$/i,
]

// Redirections that don't change what the command does; the `&` in `2>&1` is not a separator.
const FD_REDIRECT = /\d*>&\d+|&>>?\s*\S+/g
const NULL_REDIRECT = /\d*>>?\s*(\/dev\/null|nul|\$null)(?![\w.])/gi

const isWait = (part: string) => WAIT.some(rule => rule.test(part))
const isNoop = (part: string) => NOOP.some(rule => rule.test(part))

// The command split at `;`, `|`, `&`, `&&`, `||` and newlines, never inside quotes.
export function segments(command: string): string[] {
  const text = command.replace(FD_REDIRECT, ' ').replace(NULL_REDIRECT, ' ')
  const parts: string[] = []
  let current = ''
  let quote = ''
  for (const char of text) {
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

// True when the command only sleeps or does nothing: a whole turn wasted.
// A loop (`until ...; do sleep 5; done`) is not caught here: that is a blocking wait.
export function isOnlyWaiting(command: string): boolean {
  const parts = segments(command)
  return parts.length > 0 && parts.every(part => isWait(part) || isNoop(part))
}

// The check without the sleep in front of it: `sleep 60 && tail log` and
// `sleep 90; tail log` are the same check.
export function checkKey(command: string): string {
  return segments(command)
    .filter(part => !isWait(part))
    .join(' ; ')
    .replace(/\s+/g, ' ')
}
