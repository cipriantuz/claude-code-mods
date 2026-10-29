# compaction

Gives the model a `compact` tool, so it can ask for `/compact` at the end of a finished task instead of waiting for auto-compaction to hit in the middle of the next one.

## Problem

Claude Code compacts only when the user types `/compact` or when the context reaches the auto-compact threshold, which often happens mid-task. Until then every turn pays for the whole context, including tool output that is no longer needed. The model cannot run `/compact` itself, and it does not see how large its context is.

## Install

```bash
claude --plugin-dir path/to/mods/compaction
# or add the folder to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json
```

## How it works

- Registers the tool `mcp__compaction__compact` (always loaded, never deferred behind tool search) with an `instructions` argument: what the summary must keep.
- Below 150k tokens of context the tool refuses and reports the size. Above, it schedules the compaction; the compaction runs after the turn ends with reason `answer` (never after an interrupted turn), through `$.session.compact`, falling back to the `/compact` command in headless (`-p`) sessions.
- Subagents cannot compact the main conversation.
- Above 150k, every user prompt gets a one-line `[compaction]` context note with the current size, because the model cannot see it otherwise.

## Tests

```bash
claude plugin test .
```

6 tests with a simulated engine: threshold, scheduling, instructions, subagent refusal, the context note, interrupted turns.

## Limitations

- The headless fallback cannot be simulated in the test kit; it was verified live with `claude -p` on the original (pre-translation) version of this mod (66k -> 2.7k tokens, instructions kept). The interactive path is covered by the tests but was not probed live.
- The policy (when to call it) lives in the tool description; the model can still call it too early or never.
