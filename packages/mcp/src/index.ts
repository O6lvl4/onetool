import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConfirmFn, Content, OneTool, ToolSpec } from "@o6lvl4/onetool-core";

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
  const specs = onetool.toolSpecs();
  const confirm = selectConfirm(options.confirm, server);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: specs.map(toMcpTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const outcome = await onetool.handleTool(request.params.name, request.params.arguments ?? {}, {
      ...(confirm ? { confirm } : {}),
      signal: extra.signal,
      meta: { client: server.getClientVersion()?.name ?? "unknown" },
    });
    return { content: [{ type: "text", text: render(outcome.content) }], ...(outcome.isError ? { isError: true } : {}) };
  });
  return server;
}

function selectConfirm(choice: OneToolServerOptions["confirm"], server: Server): ConfirmFn | undefined {
  if (choice === "none") return undefined;
  if (typeof choice === "function") return choice;
  return elicitationConfirm(server);
}

/** Consent through MCP elicitation: the client (host application) decides how the human is asked. */
export function elicitationConfirm(server: Server): ConfirmFn {
  return async (req) => {
    if (!server.getClientCapabilities()?.elicitation) return "unavailable";
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
        properties: { approve: { type: "boolean", title: "Approve this call", description: "true runs the operation, false cancels it" } },
        required: ["approve"],
      },
    });
    if (result.action !== "accept") return "declined";
    return result.content?.["approve"] === true ? "approved" : "declined";
  };
}

export function toMcpTool(spec: ToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { ...spec.inputSchema, type: "object" } as Tool["inputSchema"],
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
