# anti-polling

Blocks the two tool calls that waste the most turns in long Claude Code sessions: a command that only waits, and the same check run for the third time in a row with nothing changed in between.

## Problem

Every tool call is a model turn, and every turn re-reads the whole context. An agent that "waits" with `sleep 60 && echo done`, or polls `curl …/status` every few seconds, pays the full context price on each call. In one measured week of the author's sessions, these calls were 1,183 turns, 6.4% of all input tokens.

## Install

```bash
# one session
claude --plugin-dir path/to/mods/anti-polling
# permanently: add the folder to CLAUDE_CODE_PLUGIN_DIRS in the env block of ~/.claude/settings.json
```

## How it works

A `tool.call` hook runs before every Bash/PowerShell call, in the main session and in subagents:

- **Wait-only commands** (`sleep`, `Start-Sleep`, `timeout /t`, `ping localhost`, `python -c "import time; time.sleep(…)"`, `true`, `echo` of literal text, and any `;`/`&&`/`|` chain made only of these) are denied before they run. The deny message tells the model how to wait without turns: `run_in_background` plus ending the turn (main session), or one blocking loop with a long timeout.
- **Repeated checks**: the third run of the same command (ignoring a leading `sleep`) is denied, unless something changed in between. A change is any non-read-only command, an edit, or another tool; `Read`/`Grep`/`Glob` and other read-only tools do not break the streak. Background commands and runs longer than 5 minutes reset it. Each subagent has its own streak; a new user turn starts from zero.

The matching rules live in `hooks/rules.ts` (pure functions, unit-tested); `hooks/register.ts` holds the streak state.

## Tests

```bash
claude plugin test .
```

15 tests: the rules, and the guard against a simulated engine and clock.

## Limitations

- Alternating two different checks (e.g. `curl` then `ssh`) is not caught.
- Numbers are not normalized: `run.py --seg 13` and `--seg 14` are different commands (by design).
