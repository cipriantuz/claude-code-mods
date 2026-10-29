import type { Register } from 'claude-code'

import { checkKey, isOnlyWaiting } from './rules.ts'

// Anti-polling guard. In one measured week of my sessions, repeated
// checks and sleeps were 1,183 turns (6.4% of all input tokens), and every turn
// re-reads the whole context. Blocks two patterns, in the main session and in
// subagents:
//  1. a command that only waits (sleep, Start-Sleep, timeout /t, true, echo);
//  2. the 3rd run of the same command with nothing changed between runs.

const MAIN = 'main'
// Which identical run gets blocked.
const STREAK = 3
// A run this long is already a blocking wait and does not count toward the streak.
const BLOCKING_MS = 5 * 60_000
// Read-only tools don't break the streak; any other tool counts as a change.
const NEUTRAL = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'TodoWrite', 'WebFetch', 'WebSearch'])

function howToWait(isMain: boolean, isPowerShell: boolean): string {
  const loop = isPowerShell
    ? '`while (-not (<condition>)) { Start-Sleep 15 }`'
    : '`until <condition>; do sleep 15; done`'
  return isMain
    ? `Wait without turns: start the job with run_in_background and end the turn (the notification wakes you up), or use one blocking command: ${loop}, with a timeout of up to 600000 ms.`
    : `Wait inside one blocking command: the job in the foreground with a timeout of up to 600000 ms, or ${loop}.`
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const register: Register = on => {
  // Per loop (main or subagent): how many times each command ran since the last change.
  const runs = new Map<string, Map<string, number>>()

  const runsOf = (loop: string) => {
    const seen = runs.get(loop) ?? new Map<string, number>()
    runs.set(loop, seen)
    return seen
  }

  // A new turn of the main session (prompt, notification, /loop) starts from zero.
  on('turn.start', ($, e, next) => {
    runs.delete(MAIN)
    return next(e)
  })

  // The subagent finished: drop everything kept for it.
  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) runs.delete(e.agentId)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? MAIN
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') {
      if (!NEUTRAL.has(String(e.tool))) runs.delete(loop)
      return next(e)
    }
    if (e.run_in_background === true) {
      runs.delete(loop)
      return next(e)
    }
    const how = howToWait(e.agentId === undefined, e.tool === 'PowerShell')
    if (isOnlyWaiting(e.command)) {
      $.ui.toast(`anti-polling: blocked a wait (${clip(e.command, 40)})`)
      return {
        deny: `anti-polling: the command only waits or does nothing, and every such call is a turn that re-reads the whole context. ${how}`,
      }
    }
    const key = checkKey(e.command)
    const count = (runsOf(loop).get(key) ?? 0) + 1
    if (count >= STREAK) {
      $.ui.toast(`anti-polling: blocked run #${count} (${clip(e.command, 40)})`)
      return {
        deny: `anti-polling: \`${clip(e.command, 80)}\` would run for time #${count} with nothing changed between runs; every check is a turn that re-reads the whole context. ${how} If running it again is really needed, change something first.`,
      }
    }
    // Nothing after `next` may throw: the tool has already run.
    const now = () => $.clock.now().catch(() => 0)
    const startedAt = await now()
    const ran = await next(e)
    const tookMs = (await now()) - startedAt
    if (ran.deny !== undefined) return ran
    if (tookMs >= BLOCKING_MS) {
      runs.delete(loop)
    } else if (ran.isReadOnly === true) {
      runsOf(loop).set(key, count)
    } else {
      // A command that changes something breaks the streak of the others.
      runs.set(loop, new Map([[key, count]]))
    }
    return ran
  })
}
