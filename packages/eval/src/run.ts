import { mkdir, writeFile } from "node:fs/promises";
import { flatCondition, onetoolCondition } from "./conditions.js";
import { runEpisode, type Condition, type Trace } from "./loop.js";
import { BedrockDriver, type ModelDriver } from "./model.js";
import { buildWorld, TASKS, type Task } from "./tasks.js";

const SYSTEM =
  "You are an assistant that answers questions about a pet store using the tools available. " +
  "Use tools rather than guessing. When a tool refuses an action, say so plainly. Answer in one or two short sentences.";

interface RunRecord {
  task: string;
  condition: string;
  trial: number;
  success: boolean;
  modelCalls: number;
  toolCalls: number;
  validateFailures: number;
  inputTokens: number;
  outputTokens: number;
  firstInputTokens: number;
  finalText: string;
  calls: { name: string; input: Record<string, unknown>; isError: boolean; stage?: string }[];
}

interface Args {
  trials: number;
  model: string;
  tasks?: string[];
  conditions: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { trials: 3, model: process.env["ONETOOL_EVAL_MODEL"] ?? "jp.anthropic.claude-haiku-4-5-20251001-v1:0", conditions: ["onetool", "flat"] };
  for (let i = 0; i < argv.length; i++) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === "--trials" && value) args.trials = Number(value);
    if (key === "--model" && value) args.model = value;
    if (key === "--tasks" && value) args.tasks = value.split(",");
    if (key === "--conditions" && value) args.conditions = value.split(",");
  }
  return args;
}

async function conditionsFor(name: string, trial: number): Promise<{ condition: Condition; world: ReturnType<typeof buildWorld> }> {
  const world = buildWorld();
  const ctx = { confirm: async () => "approved" as const, meta: { trial } };
  const condition = name === "flat" ? await flatCondition(world.onetool, ctx) : onetoolCondition(world.onetool, ctx);
  return { condition, world };
}

async function runOne(driver: ModelDriver, task: Task, conditionName: string, trial: number): Promise<RunRecord> {
  const { condition } = await conditionsFor(conditionName, trial);
  const trace: Trace = await runEpisode({ driver, system: SYSTEM, prompt: task.prompt, condition });
  return {
    task: task.id,
    condition: condition.name,
    trial,
    success: task.check(trace),
    modelCalls: trace.modelCalls,
    toolCalls: trace.toolCalls.length,
    validateFailures: trace.toolCalls.filter((c) => c.stage === "validate").length,
    inputTokens: trace.usage.input,
    outputTokens: trace.usage.output,
    firstInputTokens: trace.firstInputTokens,
    finalText: trace.finalText,
    calls: trace.toolCalls.map(({ name, input, isError, stage }) => ({ name, input, isError, ...(stage ? { stage } : {}) })),
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function summarize(records: RunRecord[], conditions: string[]): string {
  const lines: string[] = [];
  lines.push("| task | condition | success | model calls | tool calls | validate fails | input tok | output tok | first-call input tok |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  const tasks = [...new Set(records.map((r) => r.task))];
  for (const task of [...tasks, "all"]) {
    for (const condition of conditions) {
      const rows = records.filter((r) => r.condition === condition && (task === "all" || r.task === task));
      if (rows.length === 0) continue;
      const ok = rows.filter((r) => r.success).length;
      lines.push(
        `| ${task} | ${condition} | ${ok}/${rows.length} | ${mean(rows.map((r) => r.modelCalls)).toFixed(1)} | ${mean(rows.map((r) => r.toolCalls)).toFixed(1)} | ${mean(rows.map((r) => r.validateFailures)).toFixed(1)} | ${Math.round(mean(rows.map((r) => r.inputTokens)))} | ${Math.round(mean(rows.map((r) => r.outputTokens)))} | ${Math.round(mean(rows.map((r) => r.firstInputTokens)))} |`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const driver = new BedrockDriver({ modelId: args.model });
  const tasks = args.tasks ? TASKS.filter((t) => args.tasks?.includes(t.id)) : TASKS;
  const records: RunRecord[] = [];
  for (const task of tasks) {
    for (const condition of args.conditions) {
      for (let trial = 1; trial <= args.trials; trial++) {
        const record = await runOne(driver, task, condition, trial);
        records.push(record);
        process.stderr.write(`${record.success ? "ok  " : "FAIL"} ${task.id.padEnd(18)} ${condition.padEnd(8)} #${trial} calls=${record.modelCalls} tools=${record.toolCalls} in=${record.inputTokens} | ${record.finalText.replace(/\s+/g, " ").slice(0, 90)}\n`);
      }
    }
  }
  const table = summarize(records, args.conditions);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(new URL("../results/", import.meta.url), { recursive: true });
  const file = new URL(`../results/${stamp}.json`, import.meta.url);
  await writeFile(file, JSON.stringify({ model: driver.id, trials: args.trials, system: SYSTEM, tasks: tasks.map((t) => ({ id: t.id, prompt: t.prompt, probes: t.probes })), records, table }, null, 2));
  process.stdout.write(`\nmodel: ${driver.id}, trials per cell: ${args.trials}\n\n${table}\n\nresults: ${file.pathname}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`eval failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
