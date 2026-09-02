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

The four tools, with the default `api` prefix:

- `api_services` lists namespaces.
- `api_operations` lists the operations of a namespace with a summary, a kind (`read`, `write`, `sensitive`) and the policy verdict (`allow`, `confirm`, `deny`).
- `api_describe` returns one operation's description and input JSON Schema.
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
node packages/mcp/dist/cli.js onetool.config.mjs          # MCP over stdio
claude mcp add petstore -- node /path/to/onetool/packages/mcp/dist/cli.js /path/to/onetool.config.mjs
```

A runnable version lives in [examples/petstore/onetool.config.mjs](examples/petstore/onetool.config.mjs).

### An OpenAPI document

```sh
node packages/mcp/dist/cli.js --openapi https://petstore3.swagger.io/api/v3/openapi.json
node packages/mcp/dist/cli.js --openapi ./api.json --base-url https://api.example.com --header "Authorization: Bearer ..." --strict --policy ./policy.json
```

`OpenApiProvider` flattens path, query, header and cookie parameters plus the request body into one input object, so the model never needs to know where a parameter travels. Local `$ref`s are inlined and cycles are cut. GET and HEAD are `read`, everything else is `write`; `x-onetool-kind` on an operation overrides that. HTTP 400 and 422 are treated as invalid input and come back with the schema attached. YAML documents and remote `$ref`s are not supported.

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

`OneTool` does not know how a human is asked. It calls a `ConfirmFn` before a write or sensitive operation and expects `approved`, `declined` or `unavailable`.

The MCP adapter answers through elicitation when the client supports it and returns `unavailable` otherwise, which hands the decision to `onNoConfirm`. A terminal wrapper can pass a readline prompt; a chat UI can pass a button. The tool itself does not change.

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
| `@o6lvl4/onetool-mcp` | `createOneToolServer` (low-level `Server` plus elicitation) and the `onetool-mcp` CLI | core, provider-openapi, MCP SDK |

`ToolSpec` has the shape that Bedrock Converse, the Anthropic API and OpenAI function calling all share, so an adapter for any of them registers `toolSpecs()` and forwards calls to `handleTool()`.

## Development

```sh
pnpm install
pnpm run check   # build, then test: core 30, openapi 8, mcp 6
```

Not on npm yet. MIT license.
