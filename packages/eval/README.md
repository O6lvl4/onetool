# onetool eval

Does a model do better with onetool's four generic tools, or with one tool per operation?
This package runs the same tasks under both layouts against the same in-memory world
(a pet store with 10 operations and a warehouse with 3), with the same policy and auto-approved consent,
and records success, model calls, tool calls, schema-feedback events and token usage.

```sh
pnpm run build
AWS_PROFILE=<profile> pnpm --filter @o6lvl4/onetool-eval run eval -- --trials 3
pnpm --filter @o6lvl4/onetool-eval run eval -- --tasks count-sold,typed-id --conditions onetool
```

The driver talks to Amazon Bedrock Converse; `ONETOOL_EVAL_MODEL` or `--model` picks the model.
Results land in `results/<timestamp>.json` with every call trace, and a Markdown summary prints at the end.
`first-call input tok` is the input token count of the first model call: system prompt, task prompt and tool definitions,
so the difference between conditions is the cost of the tool definitions themselves.
