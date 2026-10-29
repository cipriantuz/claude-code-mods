# windows-paths

Blocks Bash tool commands on Windows that put a backslash path into a heredoc, `printf` or `echo -e`, where the backslashes do not arrive untouched and silently corrupt the file being written.

## Problem

On Windows, Claude Code's Bash tool runs Git Bash. A heredoc (even a quoted `<<'EOF'`), `printf` or `echo -e` does not pass backslashes through unchanged: the `\t` in `D:\work\tools` becomes a TAB, `\\` becomes `\`. Agents keep writing scripts and commit messages this way; in one week it corrupted files four times, even though the pitfall was already written down in the agent's memory.

## Install

```bash
claude --plugin-dir path/to/mods/windows-paths
# or add the folder to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json
```

## How it works

A `tool.call` hook on the Bash tool (main session and subagents) checks the command before it runs. If it contains a Windows path with backslashes (`X:\…` or UNC `\\server\share\…`) **and** a heredoc/here-string, `printf` or `echo -e`, the call is denied with a message that points to the fix: write the file with the Write tool and run it, or use forward slashes (`D:/work/...`); for a commit message, write it to a file and use `git commit -F`. PowerShell is not touched: its `@'…'@` here-string keeps backslashes.

The rule is in `hooks/rules.ts` (a pure function, unit-tested).

## Tests

```bash
claude plugin test .
```

6 tests: what is caught, what is let through, and the guard (blocked without running, PowerShell untouched, subagents covered).

## Limitations

- Pattern-based: a path built from variables at run time is not seen.
- It blocks rather than rewrites; the model has to choose the safe route.
