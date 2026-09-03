# onetool eval

Does a model do better with onetool's four generic tools, or with one tool per operation?
This package runs the same tasks under both layouts against the same in-memory world
(a pet store with 10 operations and a warehouse with 3), with the same policy and auto-approved consent,
and records success, model calls, tool calls, schema-feedback events and token usage.

```sh
pnpm run build
pnpm --filter @o6lvl4/onetool-eval run eval -- --trials 3                       # Claude Code headless, all tasks, onetool vs flat
pnpm --filter @o6lvl4/onetool-eval run eval -- --conditions onetool-inline      # the default onetool layout (catalog in the call tool)
pnpm --filter @o6lvl4/onetool-eval run eval -- --padding 200 --trials 1         # add 200 synthetic operations
AWS_PROFILE=<profile> pnpm --filter @o6lvl4/onetool-eval run eval -- --driver bedrock
```

Layouts: `flat` (one tool per operation), `onetool` (four tools, bare descriptions), `onetool-inline` (four tools with the operation index in the call tool, the library default).
The default driver runs Claude Code in headless mode (`claude -p`) with built-in tools off and our own system prompt, so it needs a logged-in Claude Code and nothing else;
`--driver bedrock` uses Amazon Bedrock Converse. `ONETOOL_EVAL_MODEL` or `--model` picks the model.
Results land in `results/<timestamp>.json` with every call trace, and a Markdown summary prints at the end.
`input tok` is the total input over every turn of an episode (for Claude Code: fresh, cache-creation and cache-read tokens together),
so it measures how much context the layout makes the model carry.
