# onetool

One MCP server, four tools, any API behind them.

onetool fronts every operation of an API with four generic tools (`services`, `operations`, `describe`, `call`) instead of one tool per endpoint. The shared part handles policy, consent, input validation with schema feedback, and response redaction. A provider supplies the catalog and the execution. The core has no dependencies and no agent SDK in it. MCP is one exit among possible others.

## Where it comes from

Strands Agents ships a tool called `use_aws` that exposes all of boto3 through a single tool definition. The model writes `service_name`, `operation_name` and `parameters`; Python calls `getattr(client, operation_name)(**parameters)`. When the parameters are wrong, botocore raises, and the tool answers with a JSON Schema generated from the service model so the model can fix its call on the next turn. The tool definition stays the same size whether there are three services or three hundred.

Nothing in that design is specific to AWS. Neither are its weak spots. The consent prompt reads stdin, so on a headless runtime a write fails with "Operation canceled by user" and nobody was asked. Write detection is a substring match over 30 verbs, which lets `tag_resource`, `import_certificate` and `authorize_*` through and stops `get_send_quota`. onetool keeps the mechanism and moves those two pieces out of the tool.

| use_aws | onetool |
|---|---|
| Executes through boto3 reflection | `Provider` interface: OpenAPI, in-process functions, anything |
| Consent prompt inside the tool, read from stdin | Consent is a `ConfirmFn` outside the tool. The MCP adapter uses elicitation; with nobody to ask, the default is to refuse |
| Write detection by substring over 30 verbs | Exact first-word match, provider-declared kind (HTTP method for OpenAPI), explicit policy patterns |
| Schema only after a failed call | `describe` returns it up front; failures return it too |
| Model picks `profile` and `region` | Credentials and endpoints are provider configuration, not model input |
| Python `repr` of the response, unbounded | JSON, cut at a limit with a note telling the model to narrow the request |

## How it works

```
LLM ──toolUse──▶ MCP client ──▶ onetool-mcp ──▶ OneTool ──▶ Provider ──▶ API
                     ▲               │              │
                     └─ elicitation ─┘         policy / validate /
                    (ask the human)            redact / shrink
```

Two layouts share that pipeline. `flat` registers one tool per operation (`petstore__listPets`), which the measurements below show is cheaper for small catalogs; `generic` registers four tools that stay the same size however many operations sit behind them. The default `auto` picks flat up to 30 operations. The four generic tools, with the default `api` prefix:

- `api_services` lists namespaces.
- `api_operations` lists the operations of a namespace with a summary, a kind (`read`, `write`, `sensitive`) and the policy verdict (`allow`, `confirm`, `deny`).
- `api_describe` returns one operation's description, its input JSON Schema and, when the provider knows it, its output schema.
- `api_call` runs one operation. Reads run directly. Writes and sensitive operations go through the policy, which may ask the user or refuse. Invalid input gets the schema back instead of a result.

## Quick start

```sh
git clone https://github.com/O6lvl4/onetool && cd onetool
pnpm install && pnpm run build
```

### In-process functions

```js
// onetool.config.mjs
import { FunctionProvider } from "@o6lvl4/onetool-core";

export default {
  providers: [
    new FunctionProvider("petstore", [
      { name: "listPets", summary: "List pets", handler: () => [{ id: 1, name: "Rex" }] },
      {
        name: "createPet",
        summary: "Create a pet",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
        handler: ({ name }) => ({ id: 2, name }),
      },
    ]),
  ],
  policy: { deny: ["petstore:delete*"] },
};
```

```sh
node packages/mcp/dist/cli.js onetool.config.mjs          # MCP over stdio; add --layout generic|flat|auto to override
claude mcp add petstore -- node /path/to/onetool/packages/mcp/dist/cli.js /path/to/onetool.config.mjs
```

A runnable version lives in [examples/petstore/onetool.config.mjs](examples/petstore/onetool.config.mjs).

### An OpenAPI document

```sh
node packages/mcp/dist/cli.js --openapi https://petstore3.swagger.io/api/v3/openapi.json
node packages/mcp/dist/cli.js --openapi ./api.json --base-url https://api.example.com --header "Authorization: Bearer ..." --strict --policy ./policy.json
```

`OpenApiProvider` flattens path, query, header and cookie parameters plus the request body into one input object, so the model never needs to know where a parameter travels. Local `$ref`s are inlined and cycles are cut. The output schema is the `{ status, body }` envelope the provider returns, with `body` taken from the first successful JSON response. GET and HEAD are `read`, everything else is `write`; `x-onetool-kind` on an operation overrides that. HTTP 400 and 422 are treated as invalid input and come back with the schema attached. YAML documents and remote `$ref`s are not supported.

### Other MCP servers

```sh
node packages/mcp/dist/cli.js \
  --upstream "files=npx -y @modelcontextprotocol/server-filesystem /tmp" \
  --upstream "notes=https://notes.example.com/mcp" \
  --strict --policy ./policy.json
```

`McpProvider` connects to each upstream (stdio or Streamable HTTP), turns every tool into an operation and every server into a namespace, and takes the kind from the tool's `readOnlyHint`. A host then sees four tools and one policy instead of every tool of every server. Structured results are preferred over text, so a list comes back as `{ result: [...] }`. Elicitation requests from an upstream are not forwarded yet; an upstream that needs one gets `unavailable`.

## Evidence

Does the four-tool layout actually beat one tool per operation? `packages/eval` runs the same six tasks against the same in-memory pet store (10 operations) and warehouse (3 operations) in three layouts, with Claude Code in headless mode as the agent, Claude Haiku 4.5, built-in tools switched off and the same policy underneath. Success is checked on the final answer and on which operations ran. Numbers are means over 3 trials per task; tokens are the total input over all turns of an episode, so they measure context pressure. Cost is listed for completeness but depends on how warm the prompt cache was, so compare tokens and turns.

| layout, 13 operations | success | model turns | tool calls | input tokens | output tokens |
|---|---|---|---|---|---|
| `flat`: one tool per operation | 18/18 | 2.2 | 1.2 | 6,599 | 213 |
| `onetool`: four tools, bare descriptions | 18/18 | 5.3 | 4.3 | 16,882 | 597 |
| `onetool-inline`: four tools, catalog in the call tool | 18/18 | 3.8 | 2.8 | 11,997 | 463 |

At thirteen operations the flat layout wins outright. The generic tools cost discovery turns (`services`, `operations`, `describe`) on every task, and thirteen tool definitions are cheap. Putting the operation index into the call tool's description removes part of that overhead, which is why it is now the default.

The picture flips as the catalog grows. With 200 synthetic read operations added (213 in total; one trial, three tasks):

| layout, 213 operations | success | model turns | tool calls | input tokens | output tokens |
|---|---|---|---|---|---|
| `flat` | 3/3 | 2.3 | 1.3 | 48,237 | 233 |
| `onetool` | 3/3 | 5.7 | 4.7 | 18,694 | 618 |
| `onetool-inline` | 3/3 | 3.3 | 2.3 | 11,930 | 415 |

Every turn of the flat layout carries all 213 definitions (roughly 35,000 tokens); the four generic tools stay the same size, and the inline index is bounded. Claude Code did not defer or search the 213 MCP tools in this run, so the flat cost is the real cost of a big tool list on this host.

What this says about when to use which layout: below a few dozen operations, one tool per operation is cheaper; above that, the four generic tools pay for themselves, and the inline catalog is worth its tokens at every size tested. onetool therefore offers both surfaces over the same policy, consent and redaction (`layout: "generic" | "flat" | "auto"`), and `auto`, the default, serves the flat layout up to 30 operations and the generic one beyond. The threshold sits between the two measured points and has not been measured itself. Raw traces for every episode are in [`packages/eval/results/`](packages/eval/results/); rerun with `pnpm --filter @o6lvl4/onetool-eval run eval`.

## Policy

```json
{
  "mode": "guided",
  "allow": ["petstore:list*", "petstore:getPet"],
  "confirm": ["petstore:createPet"],
  "deny": ["*:delete*"],
  "sensitive": ["vault:get*"],
  "onNoConfirm": "deny"
}
```

Patterns are `namespace:operation` with `*` wildcards. Matching ignores case, `-` and `_`, so `pet-store:list_pets` and `petstore:listPets` are the same pattern.

Precedence is `deny`, then `allow`, then `confirm`, then `sensitive` (which means confirm), then the mode default. In `guided` mode, the default, reads are allowed and writes ask. In `strict` mode anything not listed under `allow` is denied. `onNoConfirm` decides what happens when confirmation is required and nobody can answer, for example a client without elicitation. The default is `deny`.

The kind of an operation comes from the policy's `sensitive` list first, then from the provider, then from the first word of the name: `list`, `get`, `describe`, `search` and a few others mean read, anything else means write. There is no substring matching. `describeAddresses` is a read; `addTags` is a write.

## Consent

`OneTool` does not know how a human is asked. It calls a `ConfirmFn` before a write or sensitive operation and expects `approved`, `declined`, `unavailable`, or `{ approved: true, input }` when the person changed the input.

The MCP adapter answers through elicitation when the client supports it and returns `unavailable` otherwise, which hands the decision to `onNoConfirm`. The elicitation form carries an approve switch and every top-level scalar field of the input, prefilled, so the person can correct a value before approving; an edited input is validated again before the call runs. A terminal wrapper can pass a readline prompt; a chat UI can pass a button. The tool itself does not change.

```ts
import { OneTool } from "@o6lvl4/onetool-core";

const onetool = new OneTool({
  providers,
  confirm: async (req) => ((await askSomeone(req)) ? "approved" : "declined"),
});
```

## Writing a provider

```ts
import type { Provider } from "@o6lvl4/onetool-core";

const provider: Provider = {
  async namespaces() { return [{ name: "crm", summary: "customer records" }]; },
  async operations(namespace) { return [{ namespace, name: "listCustomers", summary: "...", kind: "read" }]; },
  async operation(ref) { return { ...summary, description: "...", inputSchema: { type: "object", properties: {} } }; },
  async execute(ref, input, ctx) { /* call the thing */ },
};
```

Throw `InputValidationError` when the remote side rejected the input and onetool attaches the operation's input schema to the error. Throw `OperationError` for a remote failure the model should see as is; the message and `details` pass through. Byte arrays and streams in a result are read up to a limit and decoded. Values under keys that look like secrets (`password`, `secretString`, `accessToken` and the rest of the list in `response.ts`) are replaced with `**REDACTED**`.

## Packages

| Package | Contents | Depends on |
|---|---|---|
| `@o6lvl4/onetool-core` | `OneTool`, `Policy`, validation, redaction, `FunctionProvider`, `ToolSpec` (name / description / JSON Schema) | nothing |
| `@o6lvl4/onetool-provider-openapi` | `OpenApiProvider` | core |
| `@o6lvl4/onetool-provider-mcp` | `McpProvider`, aggregating other MCP servers | core, MCP SDK |
| `@o6lvl4/onetool-eval` (private) | Harness comparing the four generic tools with one tool per operation on a real model ([README](packages/eval/README.md)) | core, Bedrock runtime |
| `@o6lvl4/onetool-mcp` | `createOneToolServer` (low-level `Server` plus elicitation) and the `onetool-mcp` CLI | core, both providers, MCP SDK |

`ToolSpec` has the shape that Bedrock Converse, the Anthropic API and OpenAI function calling all share, so an adapter for any of them registers what `tools()` returns (the layout's specs) and forwards calls to `handleTool()`, which routes both generic and flat names. The three catalog tools declare an `outputSchema`; the MCP adapter returns every successful result as `structuredContent` as well as text (plain objects as they are, anything else wrapped as `{ result }`), and the MCP client validates it against the declared schema.

## Development

```sh
pnpm install
pnpm run check   # build, test (core 35, openapi 9, mcp-provider 4, mcp 10), then the quality gate
```

`pnpm run quality` runs [codopsy](https://github.com/O6lvl4/codopsy) over `packages/` and fails when the score drops below the committed `.codopsy-baseline.json`. The current score is A (100/100) with no open findings; keep it there.

Not on npm yet. MIT license.
