export type State = 'working' | 'waiting' | 'done'

// One session's status file: ~/.claude/session-status/<id>.json
export type SessionStatus = {
  id: string
  root: string
  state: State
  task: string
  lastAction: string
  // Normalized path -> when this session last edited it (ms).
  files: Record<string, number>
  seenAt: number
  changedAt: number
  ended?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    sessions: { others: SessionStatus[] }
  }
}
