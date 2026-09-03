import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import type { JsonSchema } from "@o6lvl4/onetool-core";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelTurn {
  text: string;
  toolUses: ToolUse[];
  stop: "end" | "tool" | "max" | "other";
  usage: { input: number; output: number };
}

export interface ToolReply {
  id: string;
  text: string;
  isError: boolean;
}

export type Exchange = { role: "user"; text: string } | { role: "assistant"; turn: ModelTurn } | { role: "user"; replies: ToolReply[] };

/** The one thing the harness needs from a model: one Converse-style turn with tools. */
export interface ModelDriver {
  readonly id: string;
  converse(system: string, history: Exchange[], tools: ToolDef[]): Promise<ModelTurn>;
}

export interface BedrockDriverOptions {
  modelId: string;
  region?: string;
  maxTokens?: number;
}

const STOP: Record<string, ModelTurn["stop"]> = { tool_use: "tool", end_turn: "end", max_tokens: "max" };

/** Amazon Bedrock Converse. Credentials come from the default chain (AWS_PROFILE etc.). */
export class BedrockDriver implements ModelDriver {
  readonly id: string;
  private readonly client: BedrockRuntimeClient;
  private readonly maxTokens: number;

  constructor(options: BedrockDriverOptions) {
    this.id = options.modelId;
    this.client = new BedrockRuntimeClient({ region: options.region ?? process.env["AWS_REGION"] ?? "ap-northeast-1" });
    this.maxTokens = options.maxTokens ?? 1024;
  }

  async converse(system: string, history: Exchange[], tools: ToolDef[]): Promise<ModelTurn> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.id,
        system: [{ text: system }],
        messages: history.map(toMessage),
        toolConfig: { tools: tools.map(toTool) },
        inferenceConfig: { maxTokens: this.maxTokens, temperature: 0 },
      }),
    );
    const content = response.output?.message?.content ?? [];
    const text = content.map((b) => b.text ?? "").join("");
    const toolUses: ToolUse[] = content
      .filter((b): b is ContentBlock.ToolUseMember => b.toolUse !== undefined)
      .map((b) => ({ id: b.toolUse.toolUseId ?? "", name: b.toolUse.name ?? "", input: (b.toolUse.input ?? {}) as Record<string, unknown> }));
    const stop = STOP[response.stopReason ?? ""] ?? "other";
    return { text, toolUses, stop, usage: { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 } };
  }
}

function toTool(tool: ToolDef): Tool {
  return { toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema as Record<string, never> } } };
}

function toMessage(exchange: Exchange): Message {
  if (exchange.role === "assistant") {
    const blocks: ContentBlock[] = [];
    if (exchange.turn.text) blocks.push({ text: exchange.turn.text });
    for (const use of exchange.turn.toolUses) blocks.push({ toolUse: { toolUseId: use.id, name: use.name, input: use.input as Record<string, never> } });
    return { role: "assistant", content: blocks };
  }
  if ("text" in exchange) return { role: "user", content: [{ text: exchange.text }] };
  return {
    role: "user",
    content: exchange.replies.map((r) => ({ toolResult: { toolUseId: r.id, content: [{ text: r.text }], status: r.isError ? "error" : "success" } })),
  };
}
