---
description: Show the timeline of all AI prompts in this project with file change counts. Use when the user asks to see what the AI has done, list prompts, show history, or view the agent timeline.
---

# Timeline

Show the full timeline of Claude Code prompts for this project.

Run the `promptrail` CLI from the project root:

```bash
promptrail timeline --files --source claude
```

Optional filter:
- `--model <substring>` — filter by model name (e.g. `--model sonnet`)
- Example: `promptrail timeline --files --source claude --model sonnet`

Pass `--source claude` to show only Claude Code prompts.

This shows every prompt chronologically with:
- Prompt index (#0, #1, ...)
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

To search across prompts and responses, use `promptrail search "query"`. To view a specific prompt's AI response, use `promptrail response <n>`.
