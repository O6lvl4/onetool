import type { Exchange, ModelDriver, ToolDef, ToolReply } from "./model.js";

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  /** onetool failure stage when the call went through onetool, e.g. "validate". */
  stage?: string;
  ms: number;
}

export interface Trace {
  finalText: string;
  stop: "end" | "tool" | "max" | "other" | "turn-limit";
  modelCalls: number;
  toolCalls: ToolCallRecord[];
  usage: { input: number; output: number };
  /** Input tokens of the very first model call: system + prompt + tool definitions. */
  firstInputTokens: number;
  history: Exchange[];
}

export interface Condition {
  name: string;
  tools: ToolDef[];
  execute: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean; stage?: string }>;
}

export interface EpisodeOptions {
  driver: ModelDriver;
  system: string;
  prompt: string;
  condition: Condition;
  maxTurns?: number;
}

/** A plain agent loop: ask, run every requested tool, feed results back, stop at end_turn or the turn limit. */
export async function runEpisode({ driver, system, prompt, condition, maxTurns = 10 }: EpisodeOptions): Promise<Trace> {
  const history: Exchange[] = [{ role: "user", text: prompt }];
  const trace: Trace = { finalText: "", stop: "turn-limit", modelCalls: 0, toolCalls: [], usage: { input: 0, output: 0 }, firstInputTokens: 0, history };
  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await driver.converse(system, history, condition.tools);
    trace.modelCalls += 1;
    trace.usage.input += reply.usage.input;
    trace.usage.output += reply.usage.output;
    if (turn === 0) trace.firstInputTokens = reply.usage.input;
    history.push({ role: "assistant", turn: reply });
    if (reply.stop !== "tool" || reply.toolUses.length === 0) {
      trace.finalText = reply.text;
      trace.stop = reply.stop;
      return trace;
    }
    const replies: ToolReply[] = [];
    for (const use of reply.toolUses) {
      const started = Date.now();
      const result = await condition.execute(use.name, use.input);
      trace.toolCalls.push({ name: use.name, input: use.input, isError: result.isError, ...(result.stage ? { stage: result.stage } : {}), ms: Date.now() - started });
      replies.push({ id: use.id, text: result.text, isError: result.isError });
    }
    history.push({ role: "user", replies });
  }
  return trace;
}
