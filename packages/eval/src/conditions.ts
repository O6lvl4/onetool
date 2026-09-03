import { isPlainObject, type CallContext, type OneTool } from "@o6lvl4/onetool-core";
import type { Condition } from "./loop.js";

function stageOf(json: unknown): string | undefined {
  return isPlainObject(json) && typeof json["stage"] === "string" ? json["stage"] : undefined;
}

/** Whatever layout the OneTool is configured with, as a condition for the in-process loop. */
export async function conditionFor(name: string, onetool: OneTool, ctx: CallContext): Promise<Condition> {
  const { specs } = await onetool.tools();
  return {
    name,
    tools: specs.map(({ name: toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema })),
    execute: async (tool, input) => {
      const outcome = await onetool.handleTool(tool, input, ctx);
      const json = "json" in outcome.content ? outcome.content.json : undefined;
      const text = "text" in outcome.content ? outcome.content.text : JSON.stringify(json);
      const stage = outcome.isError ? stageOf(json) : undefined;
      return { text, isError: outcome.isError, ...(stage ? { stage } : {}) };
    },
  };
}
