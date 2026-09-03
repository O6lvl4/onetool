import { isPlainObject, type CallContext, type OneTool } from "@o6lvl4/onetool-core";
import type { Condition } from "./loop.js";
import type { ToolDef } from "./model.js";

function stageOf(json: unknown): string | undefined {
  return isPlainObject(json) && typeof json["stage"] === "string" ? json["stage"] : undefined;
}

/** onetool as shipped: four generic tools, routed through handleTool. */
export async function onetoolCondition(onetool: OneTool, ctx: CallContext): Promise<Condition> {
  return {
    name: "onetool",
    tools: (await onetool.toolSpecsWithCatalog()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    execute: async (name, input) => {
      const outcome = await onetool.handleTool(name, input, ctx);
      const json = "json" in outcome.content ? outcome.content.json : undefined;
      const text = "text" in outcome.content ? outcome.content.text : JSON.stringify(json);
      const stage = outcome.isError ? stageOf(json) : undefined;
      return { text, isError: outcome.isError, ...(stage ? { stage } : {}) };
    },
  };
}

/** The conventional layout: one tool per operation, same policy and consent underneath. */
export async function flatCondition(onetool: OneTool, ctx: CallContext): Promise<Condition> {
  const tools: ToolDef[] = [];
  const refs = new Map<string, { namespace: string; operation: string }>();
  for (const ns of await onetool.services()) {
    for (const op of await onetool.operations(ns.name)) {
      const spec = (await onetool.describe(ns.name, op.name)).spec;
      const name = `${ns.name}__${op.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      refs.set(name, { namespace: ns.name, operation: op.name });
      tools.push({ name, description: spec.description === spec.summary ? spec.summary : `${spec.summary}. ${spec.description}`, inputSchema: spec.inputSchema });
    }
  }
  return {
    name: "flat",
    tools,
    execute: async (name, input) => {
      const ref = refs.get(name);
      if (!ref) return { text: `unknown tool ${name}`, isError: true };
      const result = await onetool.call({ namespace: ref.namespace, operation: ref.operation, input }, ctx);
      if (result.ok) return { text: "text" in result.content ? result.content.text : JSON.stringify(result.content.json), isError: false };
      return { text: JSON.stringify(result), isError: true, stage: result.stage };
    },
  };
}
