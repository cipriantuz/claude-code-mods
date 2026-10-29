# handoff

Cache-aware session handoff: after a pause long enough for the prompt cache to expire, asks whether to continue in a new session that starts from a written summary instead of re-writing a huge context into the cache.

## Problem

The prompt cache lives for about an hour. Coming back to a session with 250k tokens of context after a lunch break re-writes all of it into the cache on the first prompt. In one measured week of the author's sessions, 40 such resumes re-wrote ~290k tokens each, 30% of all cache writes.

## Install

```bash
claude --plugin-dir path/to/mods/handoff
# or add the folder to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json
```

## How it works

- **The question.** On the first prompt typed after more than 1 hour since the last cache read, with a context of at least 100k tokens, a dialog offers *New session with a summary* or *Continue here*. Esc puts the prompt back in the box and lets the next Enter through.
- **Precomputed summary.** 55 minutes after the last turn (cache still warm), the summary is written through a forked request that reads the context from the cache. That read also extends the cache's life, so a resume up to ~1 h 55 min neither asks nor re-writes anything. After that, the dialog says the summary is already written and the new session starts without another model call.
- **Guards.** A timer that fires late (machine asleep) does not fork. A fork that writes more to the cache than it reads (the cache was cold) turns precomputing off for the session. A new turn makes an old summary stale.
- **Without a ready summary**, the note comes from a fork when the cache is warm, or from a condensed transcript (prompts, replies and tool names, no tool results) when it is cold, so the summary itself does not re-write the cache.
- **The switch.** Note -> `~/.claude/handoffs/<date>_<sid8>.md` (with `claude --resume <id>` for the old session) -> `/clear` -> the note appended to the new session -> the held prompt submitted. If any step fails, the session stays as it was and the prompt goes back to the box.
- `/handoff [first prompt]` does the same on demand.

## Tests

```bash
claude plugin test .
```

19 tests with a simulated engine and clock: the dialog, the 55-minute precompute, the late-timer and cold-fork guards, the fallback paths.

## Limitations

- After `claude --resume` the mod does not know the previous turn time, so it does not ask; `/handoff` still works.
- The summary quality depends on the model; the note format asks for task, state, decisions, files, next steps and open questions.
