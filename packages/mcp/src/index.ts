import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { isPlainObject, toStructured, type ConfirmDecision, type ConfirmFn, type ConfirmRequest, type Content, type JsonSchema, type OneTool, type ToolSpec } from "@o6lvl4/onetool-core";

export const VERSION = "0.1.0";

export interface OneToolServerOptions {
  name?: string;
  version?: string;
  /** Shown to the client as server instructions. */
  instructions?: string;
  /**
   * How a human is asked before a `confirm` operation runs.
   * `"elicitation"` (default) uses MCP elicitation and reports `unavailable` when the client lacks it;
   * `"none"` never asks (the policy's `onNoConfirm` then decides); a function plugs in anything else.
   */
  confirm?: ConfirmFn | "elicitation" | "none";
}

/** Build a low-level MCP `Server` that fronts a OneTool instance. Connect it to any transport. */
export function createOneToolServer(onetool: OneTool, options: OneToolServerOptions = {}): Server {
  const server = new Server(
    { name: options.name ?? "onetool", version: options.version ?? VERSION },
    { capabilities: { tools: {} }, ...(options.instructions ? { instructions: options.instructions } : {}) },
  );
  const confirm = selectConfirm(options.confirm, server);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await onetool.tools()).specs.map(toMcpTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const outcome = await onetool.handleTool(request.params.name, request.params.arguments ?? {}, {
      ...(confirm ? { confirm } : {}),
      signal: extra.signal,
      meta: { client: server.getClientVersion()?.name ?? "unknown" },
    });
    if (outcome.isError) return { content: [{ type: "text", text: render(outcome.content) }], isError: true };
    return { content: [{ type: "text", text: render(outcome.content) }], structuredContent: toStructured(outcome.content) };
  });
  return server;
}

function selectConfirm(choice: OneToolServerOptions["confirm"], server: Server): ConfirmFn | undefined {
  if (choice === "none") return undefined;
  if (typeof choice === "function") return choice;
  return elicitationConfirm(server);
}

type FormField =
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | { type: "string"; title?: string; description?: string; default?: string }
  | { type: "string"; title?: string; description?: string; enum: string[]; default?: string }
  | { type: "number" | "integer"; title?: string; description?: string; default?: number };

/**
 * Consent through MCP elicitation: the client (host application) decides how the human is asked.
 * The form carries the approve switch plus every top-level scalar input field, prefilled, so the
 * person can correct a value before approving. Nested values are shown in the message and kept as they are.
 */
export function elicitationConfirm(server: Server): ConfirmFn {
  return async (req) => {
    if (!server.getClientCapabilities()?.elicitation) return "unavailable";
    const fields = editableFields(req);
    const input = JSON.stringify(req.input);
    const message = [
      `Run ${req.ref.namespace}:${req.ref.name}? (${req.summary})`,
      `Reason: ${req.verdictReason}`,
      `Input: ${input.length > 600 ? `${input.slice(0, 600)}…` : input}`,
    ].join("\n");
    const result = await server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: { approve: { type: "boolean", title: "Approve this call", description: "true runs the operation, false cancels it", default: true }, ...fields },
        required: ["approve"],
      },
    });
    return decisionFrom(req, result.action, result.content, Object.keys(fields));
  };
}

/** Top-level scalar members of the input become form fields, typed from the schema where it says so. */
function editableFields(req: ConfirmRequest): Record<string, FormField> {
  const props = (req.inputSchema["properties"] ?? {}) as Record<string, JsonSchema>;
  const fields: Record<string, FormField> = {};
  for (const [key, value] of Object.entries(req.input)) {
    const field = formField(props[key], value);
    if (field) fields[key] = field;
  }
  return fields;
}

function formField(schema: JsonSchema | undefined, value: unknown): FormField | undefined {
  const description = typeof schema?.["description"] === "string" ? { description: schema["description"] } : {};
  if (typeof value === "boolean") return { type: "boolean", default: value, ...description };
  if (typeof value === "number") return { type: schema?.["type"] === "integer" ? "integer" : "number", default: value, ...description };
  if (typeof value !== "string") return undefined;
  const allowed = schema?.["enum"];
  if (Array.isArray(allowed) && allowed.every((v): v is string => typeof v === "string")) return { type: "string", enum: allowed, default: value, ...description };
  return { type: "string", default: value, ...description };
}

function decisionFrom(req: ConfirmRequest, action: string, content: Record<string, unknown> | undefined, editable: string[]): ConfirmDecision {
  if (action !== "accept" || !isPlainObject(content) || content["approve"] !== true) return "declined";
  const edited: Record<string, unknown> = { ...req.input };
  let changed = false;
  for (const key of editable) {
    if (key in content && content[key] !== req.input[key]) {
      edited[key] = content[key];
      changed = true;
    }
  }
  return changed ? { approved: true, input: edited } : "approved";
}

export function toMcpTool(spec: ToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { ...spec.inputSchema, type: "object" } as Tool["inputSchema"],
    ...(spec.outputSchema ? { outputSchema: { ...spec.outputSchema, type: "object" } as Tool["outputSchema"] } : {}),
    annotations: {
      readOnlyHint: spec.annotations.readOnly,
      destructiveHint: spec.annotations.destructive,
      idempotentHint: spec.annotations.idempotent,
      openWorldHint: spec.annotations.openWorld,
    },
  };
}

function render(content: Content): string {
  return "text" in content ? content.text : JSON.stringify(content.json);
}
