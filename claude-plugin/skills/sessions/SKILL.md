---
description: List all AI agent sessions (Claude Code and Cursor) for this project. Use when the user asks about sessions, wants to see which AI sessions exist, or asks about session history.
---

# Sessions

List all AI agent sessions for this project.

```bash
promptrail sessions
```

Optional filters:
- `--source claude` or `--source cursor` — show only one source
- `--model <substring>` — filter by model name (e.g. `--model sonnet`)

This shows each session with:
- Source (Claude Code or Cursor)
- Session ID (truncated)
- Number of prompts
- Last activity time
- Model used

Present the output in a clean format. If the user wants details about a specific session, suggest using `/promptrail:timeline` to see all prompts.
