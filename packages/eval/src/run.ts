import { mkdir, writeFile } from "node:fs/promises";
import { runClaudeCode } from "./claude-code.js";
import { conditionFor } from "./conditions.js";
import { runEpisode, type Condition, type Trace } from "./loop.js";
import { BedrockDriver } from "./model.js";
import type { Layout } from "./mcp-server.js";
import { buildWorld, TASKS, type Task } from "./tasks.js";

const SYSTEM =
  "You are an assistant that answers questions about a pet store using the tools available. " +
  "Use tools rather than guessing. When a tool refuses an action, say so plainly. Answer in one or two short sentences.";

export interface RunRecord {
  task: string;
  condition: string;
  trial: number;
  success: boolean;
  modelCalls: number;
  toolCalls: number;
  validateFailures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  finalText: string;
  calls: { name: string; input: Record<string, unknown>; isError: boolean; stage?: string }[];
}

interface Args {
  driver: "claude-code" | "bedrock";
  trials: number;
  model: string;
  padding: number;
  tasks?: string[];
  conditions: Layout[];
}

const LAYOUTS: Layout[] = ["onetool", "onetool-inline", "flat"];

const DEFAULT_MODEL = { "claude-code": "claude-haiku-4-5-20251001", bedrock: "jp.anthropic.claude-haiku-4-5-20251001-v1:0" } as const;

const SETTERS: Record<string, (args: Args, value: string) => void> = {
  "--driver": (a, v) => {
    if (v === "claude-code" || v === "bedrock") a.driver = v;
  },
  "--trials": (a, v) => (a.trials = Number(v)),
  "--model": (a, v) => (a.model = v),
  "--padding": (a, v) => (a.padding = Number(v)),
  "--tasks": (a, v) => (a.tasks = v.split(",")),
  "--conditions": (a, v) => (a.conditions = v.split(",").filter((c): c is Layout => (LAYOUTS as string[]).includes(c))),
};

function parseArgs(argv: string[]): Args {
  const args: Args = { driver: "claude-code", trials: 3, model: "", padding: 0, conditions: ["onetool", "flat"] };
  for (let i = 0; i + 1 < argv.length; i += 2) {
    const setter = SETTERS[argv[i] ?? ""];
    if (setter) setter(args, argv[i + 1] ?? "");
  }
  args.model ||= process.env["ONETOOL_EVAL_MODEL"] ?? DEFAULT_MODEL[args.driver];
  return args;
}

interface Cell {
  task: Task;
  condition: string;
  trial: number;
}

function record({ task, condition, trial }: Cell, trace: Trace, extra: { inputTokens: number; outputTokens: number; costUsd: number }): RunRecord {
  return {
    task: task.id,
    condition,
    trial,
    success: task.check(trace),
    modelCalls: trace.modelCalls,
    toolCalls: trace.toolCalls.length,
    validateFailures: trace.toolCalls.filter((c) => c.stage === "validate").length,
    ...extra,
    finalText: trace.finalText,
    calls: trace.toolCalls.map(({ name, input, isError, stage }) => ({ name, input, isError, ...(stage ? { stage } : {}) })),
  };
}

async function runBedrock(args: Args, task: Task, layout: Layout, trial: number): Promise<RunRecord> {
  const world = buildWorld({ layout, padding: args.padding });
  const ctx = { confirm: async () => "approved" as const, meta: { trial } };
  const condition: Condition = await conditionFor(layout, world.onetool, ctx);
  const trace = await runEpisode({ driver: new BedrockDriver({ modelId: args.model }), system: SYSTEM, prompt: task.prompt, condition });
  return record({ task, condition: layout, trial }, trace, { inputTokens: trace.usage.input, outputTokens: trace.usage.output, costUsd: 0 });
}

async function runClaude(args: Args, task: Task, layout: Layout, trial: number): Promise<RunRecord> {
  const episode = await runClaudeCode({ model: args.model, layout, padding: args.padding, system: SYSTEM, prompt: task.prompt });
  const trace: Trace = {
    finalText: episode.finalText,
    stop: episode.stopReason === "end_turn" ? "end" : "other",
    modelCalls: episode.numTurns,
    toolCalls: episode.calls.map((c) => ({ name: c.tool, input: c.input, isError: c.isError, ...(c.stage ? { stage: c.stage } : {}), ms: c.ms })),
    usage: { input: 0, output: 0 },
    firstInputTokens: 0,
    history: [],
  };
  const inputTokens = episode.usage.input + episode.usage.cacheCreate + episode.usage.cacheRead;
  return record({ task, condition: layout, trial }, trace, { inputTokens, outputTokens: episode.usage.output, costUsd: episode.costUsd });
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function summarize(records: RunRecord[], conditions: string[]): string {
  const lines = [
    "| task | condition | success | model turns | tool calls | validate fails | input tok | output tok | cost USD |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const tasks = [...new Set(records.map((r) => r.task))];
  for (const task of [...tasks, "all"]) {
    for (const condition of conditions) {
      const rows = records.filter((r) => r.condition === condition && (task === "all" || r.task === task));
      if (rows.length === 0) continue;
      const ok = rows.filter((r) => r.success).length;
      const cells = [
        task,
        condition,
        `${ok}/${rows.length}`,
        mean(rows.map((r) => r.modelCalls)).toFixed(1),
        mean(rows.map((r) => r.toolCalls)).toFixed(1),
        mean(rows.map((r) => r.validateFailures)).toFixed(1),
        Math.round(mean(rows.map((r) => r.inputTokens))).toLocaleString("en-US"),
        Math.round(mean(rows.map((r) => r.outputTokens))).toLocaleString("en-US"),
        mean(rows.map((r) => r.costUsd)).toFixed(4),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = args.tasks ? TASKS.filter((t) => args.tasks?.includes(t.id)) : TASKS;
  const records: RunRecord[] = [];
  const started = Date.now();
  for (const task of tasks) {
    for (const layout of args.conditions) {
      for (let trial = 1; trial <= args.trials; trial++) {
        const r = args.driver === "bedrock" ? await runBedrock(args, task, layout, trial) : await runClaude(args, task, layout, trial);
        records.push(r);
        process.stderr.write(
          `${r.success ? "ok  " : "FAIL"} ${task.id.padEnd(18)} ${layout.padEnd(8)} #${trial} turns=${r.modelCalls} tools=${r.toolCalls} in=${r.inputTokens} out=${r.outputTokens} | ${r.finalText.replace(/\s+/g, " ").slice(0, 90)}\n`,
        );
      }
    }
  }
  const table = summarize(records, args.conditions);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(new URL("../results/", import.meta.url), { recursive: true });
  const file = new URL(`../results/${stamp}.json`, import.meta.url);
  const meta = { driver: args.driver, model: args.model, trials: args.trials, padding: args.padding, system: SYSTEM, durationMs: Date.now() - started };
  await writeFile(file, JSON.stringify({ ...meta, tasks: tasks.map((t) => ({ id: t.id, prompt: t.prompt, probes: t.probes })), records, table }, null, 2));
  process.stdout.write(`\ndriver: ${args.driver}, model: ${args.model}, trials per cell: ${args.trials}, padding: ${args.padding}\n\n${table}\n\nresults: ${file.pathname}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`eval failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
