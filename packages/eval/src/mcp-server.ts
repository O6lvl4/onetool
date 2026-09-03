#!/usr/bin/env node
/**
 * The world of tasks.ts served over MCP in one of two layouts, so an external agent
 * (Claude Code in headless mode) can be measured instead of a hand-written loop.
 *
 *   ONETOOL_EVAL_LAYOUT=onetool         four generic tools (default)
 *   ONETOOL_EVAL_LAYOUT=onetool-inline  four generic tools with the operation index inside the call tool
 *   ONETOOL_EVAL_LAYOUT=flat            one tool per operation
 *   ONETOOL_EVAL_PADDING=<n>            add n synthetic operations to the world
 *   ONETOOL_EVAL_LOG=<file>             every tool call is appended as one JSON line
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { isPlainObject, toStructured, type CallContext, type Content, type OneTool } from "@o6lvl4/onetool-core";
import { buildWorld } from "./tasks.js";

export interface LoggedCall {
  tool: string;
  input: Record<string, unknown>;
  isError: boolean;
  stage?: string;
  ms: number;
}

const layout = (["flat", "onetool-inline"].find((l) => l === process.env["ONETOOL_EVAL_LAYOUT"]) ?? "onetool") as Layout;
const padding = Number(process.env["ONETOOL_EVAL_PADDING"] ?? 0);
export type Layout = "onetool" | "onetool-inline" | "flat";
const logFile = process.env["ONETOOL_EVAL_LOG"];
const ctx: CallContext = { confirm: async () => "approved", meta: { layout } };

function log(entry: LoggedCall): void {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function render(content: Content): string {
  return "text" in content ? content.text : JSON.stringify(content.json);
}

function stageOf(json: unknown): string | undefined {
  return isPlainObject(json) && typeof json["stage"] === "string" ? json["stage"] : undefined;
}

async function flatTools(onetool: OneTool): Promise<{ tools: Tool[]; refs: Map<string, { namespace: string; operation: string }> }> {
  const tools: Tool[] = [];
  const refs = new Map<string, { namespace: string; operation: string }>();
  for (const ns of await onetool.services()) {
    for (const op of await onetool.operations(ns.name)) {
      const { spec } = await onetool.describe(ns.name, op.name);
      const name = `${ns.name}__${op.name}`;
      refs.set(name, { namespace: ns.name, operation: op.name });
      tools.push({
        name,
        description: spec.description === spec.summary ? spec.summary : `${spec.summary}. ${spec.description}`,
        inputSchema: { ...spec.inputSchema, type: "object" } as Tool["inputSchema"],
        annotations: { readOnlyHint: spec.kind === "read", destructiveHint: spec.kind !== "read" },
      });
    }
  }
  return { tools, refs };
}

async function main(): Promise<void> {
  const { onetool } = buildWorld({ inlineCatalog: layout === "onetool-inline", padding });
  const server = new Server({ name: `onetool-eval-${layout}`, version: "0.0.0" }, { capabilities: { tools: {} } });

  if (layout === "flat") {
    const { tools, refs } = await flatTools(onetool);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const started = Date.now();
      const ref = refs.get(request.params.name);
      const input = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (!ref) {
        log({ tool: request.params.name, input, isError: true, stage: "resolve", ms: 0 });
        return { content: [{ type: "text", text: `unknown tool ${request.params.name}` }], isError: true };
      }
      const result = await onetool.call({ namespace: ref.namespace, operation: ref.operation, input }, ctx);
      if (result.ok) {
        log({ tool: request.params.name, input, isError: false, ms: Date.now() - started });
        return { content: [{ type: "text", text: render(result.content) }], structuredContent: toStructured(result.content) };
      }
      log({ tool: request.params.name, input, isError: true, stage: result.stage, ms: Date.now() - started });
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
    });
  } else {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await onetool.toolSpecsWithCatalog()).map((s) => ({
        name: s.name,
        description: s.description,
        inputSchema: { ...s.inputSchema, type: "object" } as Tool["inputSchema"],
        ...(s.outputSchema ? { outputSchema: { ...s.outputSchema, type: "object" } as Tool["outputSchema"] } : {}),
        annotations: { readOnlyHint: s.annotations.readOnly, destructiveHint: s.annotations.destructive, idempotentHint: s.annotations.idempotent, openWorldHint: s.annotations.openWorld },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const started = Date.now();
      const input = (request.params.arguments ?? {}) as Record<string, unknown>;
      const outcome = await onetool.handleTool(request.params.name, input, ctx);
      const json = "json" in outcome.content ? outcome.content.json : undefined;
      const stage = outcome.isError ? stageOf(json) : undefined;
      log({ tool: request.params.name, input, isError: outcome.isError, ...(stage ? { stage } : {}), ms: Date.now() - started });
      if (outcome.isError) return { content: [{ type: "text", text: render(outcome.content) }], isError: true };
      return { content: [{ type: "text", text: render(outcome.content) }], structuredContent: toStructured(outcome.content) };
    });
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`onetool-eval mcp-server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
