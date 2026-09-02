import type { OneTool } from "./onetool.js";
import { ResolveError } from "./resolve.js";
import { isPlainObject } from "./schema.js";
import type { CallContext, ToolOutcome, ToolSpec } from "./types.js";

const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

/** The four generic tools, in the name / description / JSON Schema shape every function-calling API shares. */
export function buildToolSpecs(prefix: string, title: string): ToolSpec[] {
  const namespace = { type: "string", description: "Namespace (service) of the operation. Omit when only one namespace exists." };
  const operation = { type: "string", description: "Operation name. camelCase, PascalCase and snake_case are all accepted." };
  const query = (of: string) => ({ type: "string", description: `Optional substring filter on ${of}.` });
  return [
    {
      name: `${prefix}_services`,
      description: `List the namespaces (services) reachable through ${title}. Use it when unsure which namespace an operation belongs to.`,
      inputSchema: { type: "object", properties: { query: query("name or summary") }, additionalProperties: false },
      annotations: READ_ONLY,
    },
    {
      name: `${prefix}_operations`,
      description:
        "List operations of a namespace with a one-line summary, their kind (read / write / sensitive) and the policy verdict (allow / confirm / deny).",
      inputSchema: { type: "object", properties: { namespace, query: query("name, summary or tags") }, additionalProperties: false },
      annotations: READ_ONLY,
    },
    {
      name: `${prefix}_describe`,
      description: `Return the full description and the JSON input schema of one operation. Call it before ${prefix}_call whenever the parameters are uncertain.`,
      inputSchema: { type: "object", properties: { namespace, operation }, required: ["operation"], additionalProperties: false },
      annotations: READ_ONLY,
    },
    {
      name: `${prefix}_call`,
      description: `Execute one operation of ${title} with a JSON input. Read operations run directly; write and sensitive operations may ask the user for confirmation or be denied by policy. When the input is invalid, the expected schema is returned instead of a result.`,
      inputSchema: {
        type: "object",
        properties: { namespace, operation, input: { type: "object", description: `Operation input. Get the schema from ${prefix}_describe.` } },
        required: ["operation"],
        additionalProperties: false,
      },
      annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
    },
  ];
}

type Args = Record<string, unknown>;
type Handler = (onetool: OneTool, args: Args, ctx: CallContext) => Promise<ToolOutcome>;

const HANDLERS: Record<string, Handler> = {
  services: async (onetool, args) => ok(await onetool.services(str(args, "query"))),
  operations: async (onetool, args) => ok(await onetool.operations(str(args, "namespace"), str(args, "query"))),
  describe: async (onetool, args) => {
    const operation = str(args, "operation");
    if (!operation) return fail({ error: "operation is required" });
    const d = await onetool.describe(str(args, "namespace"), operation);
    return ok({ ...d.spec, kind: d.kind, verdict: d.verdict, reason: d.reason });
  },
  call: async (onetool, args, ctx) => {
    const operation = str(args, "operation");
    if (!operation) return fail({ error: "operation is required" });
    const namespace = str(args, "namespace");
    const input = isPlainObject(args["input"]) ? args["input"] : undefined;
    const result = await onetool.call({ operation, ...(namespace ? { namespace } : {}), ...(input ? { input } : {}) }, ctx);
    return result.ok ? { isError: false, content: result.content } : fail(result);
  },
};

/** Route a tool invocation by name. Adapters register `buildToolSpecs()` and forward calls here. */
export async function dispatchTool(onetool: OneTool, name: string, args: unknown, ctx: CallContext): Promise<ToolOutcome> {
  const suffix = name.startsWith(`${onetool.prefix}_`) ? name.slice(onetool.prefix.length + 1) : "";
  const handler = HANDLERS[suffix];
  if (!handler) {
    const expected = buildToolSpecs(onetool.prefix, "").map((t) => t.name).join(", ");
    return fail({ error: `unknown tool "${name}"; expected one of ${expected}` });
  }
  try {
    return await handler(onetool, isPlainObject(args) ? args : {}, ctx);
  } catch (error) {
    if (error instanceof ResolveError) return fail({ error: error.message, candidates: error.candidates });
    return fail({ error: error instanceof Error ? error.message : String(error) });
  }
}

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function ok(json: unknown): ToolOutcome {
  return { isError: false, content: { json } };
}

function fail(json: unknown): ToolOutcome {
  return { isError: true, content: { json } };
}
