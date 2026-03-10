---
description: Show the timeline of all AI prompts in this project with file change counts. Use when the user asks to see what the AI has done, list prompts, show history, or view the agent timeline.
---

# Timeline

Show the full timeline of AI agent prompts (Claude Code + Cursor) for this project.

Run the `promptrail` CLI from the project root:

```bash
promptrail timeline --files
```

Optional filters:
- `--source claude` or `--source cursor` — show only one source
- `--model <substring>` — filter by model name (e.g. `--model sonnet`, `--model gpt`)
- Combine: `promptrail timeline --files --source claude --model sonnet`

This shows every prompt chronologically with:
- Prompt index (#0, #1, ...)
- Source (Claude Code or Cursor)
- Truncated prompt text
- Number of files changed
- Time ago
- Model used
- File list per prompt

If `promptrail` is not found, install it first:

```bash
cd $ARGUMENTS
npm link
```

Then retry the timeline command.

Present the output to the user in a clean, readable format. Highlight prompts that changed many files.
