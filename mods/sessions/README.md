# sessions

Multi-session conflict detection: Claude Code sessions open in the same folder see each other, and a session that edits a file another live session edited recently gets a warning before it commits someone else's work.

## Problem

Running several Claude Code sessions in one checkout is common (one refactors, one writes docs, one fixes a bug). They do not know about each other: two sessions edit the same file, and a broad `git add` sweeps the other session's half-done work into a commit.

## Install

```bash
claude --plugin-dir path/to/mods/sessions
# or add the folder to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json
```

## How it works

- Each interactive session writes its status to `~/.claude/session-status/<id>.json`: the task (last prompt), the state (`working`, `waiting`, `done`), the last action, and the files it edited in the last 6 hours. Heartbeat every 60 s; the others are read every 15 s; no heartbeat for 3 minutes = closed.
- A strip above the prompt lists the live sessions in the same folder, plus how many sessions in other folders are waiting for you. `/sessions` prints the full list.
- An `Edit`/`Write` on a file another live session in the same folder touched in the last 6 hours shows a toast and appends a note for the model ("stage only your own hunks when committing"), once per file and session.
- `waiting` comes from permission prompts and from `AskUserQuestion`/`ExitPlanMode`. `/clear` and `/resume` continue under the new session id.
- No model calls. Headless `claude -p` sessions do not register.

The [approval-channel](../approval-channel) dispatcher reads the same status files to number sessions and to alert you when one is waiting.

## Tests

```bash
claude plugin test .
```

2 scenario tests with an in-memory disk: neighbour detection, the strip, the `/sessions` list, the single conflict warning, and the `/clear` -> `/resume` -> `/clear` regression.

## Limitations

- The mod API has no delete: ended sessions leave their file behind (`ended: true`); files older than 24 hours are not read.
- Detection is per file, not per hunk.
