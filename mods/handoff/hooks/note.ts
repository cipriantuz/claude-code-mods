import type { SessionMessage } from 'claude-code'

// The handoff texts and the condensed transcript. No side effects: register.ts
// uses these, the tests check them directly.

export const NEW_SESSION = 'New session with a summary'
export const STAY = 'Continue here'

export const NOTE_REQUEST = `Write the handoff note for a new Claude Code session that continues the work from here without this history. Reply with the note only, in the language of the conversation, at most ~500 words, with these sections:

## Task
What the user asked for and the goal, in 1-3 sentences.
## State
What is done and verified (with the evidence, briefly) and what is half done.
## Decisions
What was chosen and why; what the user explicitly asked for or rejected.
## Files and context
The absolute paths touched or important, the branch or worktree, the servers and jobs started.
## Next steps
Concrete, in order.
## Open
Unresolved questions or risks.

Do not invent: leave out whatever does not follow from the conversation. No introduction and no closing.`

export const CONDENSED_SYSTEM = "You receive the condensed transcript of a Claude Code session: the user's prompts (USER), the assistant's replies (ASSISTANT) and the tools used, briefly ([Tool] argument). Tool results are missing, so infer the state from the replies."

const HEAD_CHARS = 6_000
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// The argument that says what the tool did: the command, the file, the search.
export function describeInput(input: Readonly<Record<string, unknown>>): string {
  for (const key of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value.replace(/\s+/g, ' ')
  }
  return JSON.stringify(input)
}

// Prompts, replies and tools in short, without tool results and without the
// <system-reminder> blocks. Over budget: keep the beginning (the original request)
// and the newest part.
export function condense(messages: readonly SessionMessage[], budget = 120_000): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = message.text.replace(REMINDER, '').trim()
    if (message.role === 'user') {
      if (text !== '') lines.push(`USER: ${clip(text, 2_000)}`)
      continue
    }
    if (text !== '') lines.push(`ASSISTANT: ${clip(text, 1_500)}`)
    for (const use of message.toolUses) {
      lines.push(`  [${use.tool}] ${clip(describeInput(use.input), 160)}${use.isError === true ? ' (error)' : ''}`)
    }
  }
  const head: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length > HEAD_CHARS) break
    head.push(line)
    used += line.length + 1
  }
  const tail: string[] = []
  for (let i = lines.length - 1; i >= head.length; i -= 1) {
    const line = lines[i] ?? ''
    if (used + line.length > budget) break
    tail.unshift(line)
    used += line.length + 1
  }
  const skipped = lines.length - head.length - tail.length
  return [...head, ...(skipped > 0 ? [`[… ${skipped} lines omitted …]`] : []), ...tail].join('\n')
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export function question(idleMs: number, contextTokens: number, isReady = false): string {
  const ready = isReady ? ' The summary is already written.' : ''
  return `Paused for ${formatDuration(idleMs)}: the cache has expired, and the context has ${Math.round(contextTokens / 1000)}k tokens, which continuing here re-writes.${ready} Start a new session with a summary?`
}

const pad = (value: number) => String(value).padStart(2, '0')

// `<dir>/2026-10-03_1842_3fb6ad20.md`, in local time, with `/` everywhere
// (USERPROFILE comes with backslashes).
export function notePath(dir: string, at: number, sessionId: string): string {
  const time = new Date(at)
  const stamp = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}_${pad(time.getHours())}${pad(time.getMinutes())}`
  return `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/${stamp}_${sessionId.slice(0, 8)}.md`
}

export function noteFile(note: string, sessionId: string): string {
  return `# Handoff ${sessionId.slice(0, 8)}\n\nPrevious session: \`claude --resume ${sessionId}\`\n\n${note}\n`
}

// What the model reads in the new session, before the first prompt.
export function framed(note: string, sessionId: string, path?: string): string {
  const saved = path === undefined ? '' : `, also saved in ${path}`
  return `Handoff from the previous session (${sessionId.slice(0, 8)})${saved}. Continue from here; if a detail is missing, read the files the note names.\n\n${note}`
}
