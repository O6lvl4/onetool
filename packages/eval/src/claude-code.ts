/**
 * Drives Claude Code in headless mode (`claude -p`) as the agent under test. Each episode gets a fresh
 * MCP server process in the chosen layout and an empty working directory, so the only tools that matter
 * are the ones we serve. Metrics come from the CLI's JSON output and from the server's call log.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Layout, LoggedCall } from "./mcp-server.js";

export interface ClaudeCodeOptions {
  model: string;
  layout: Layout;
  padding: number;
  system: string;
  prompt: string;
  maxTurns?: number;
}

export interface ClaudeCodeEpisode {
  finalText: string;
  stopReason: string;
  isError: boolean;
  numTurns: number;
  usage: { input: number; cacheCreate: number; cacheRead: number; output: number };
  costUsd: number;
  durationMs: number;
  calls: LoggedCall[];
}

interface CliJson {
  result?: string;
  stop_reason?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  duration_api_ms?: number;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
}

const SERVER = fileURLToPath(new URL("./mcp-server.js", import.meta.url));

export async function runClaudeCode(options: ClaudeCodeOptions): Promise<ClaudeCodeEpisode> {
  const dir = await mkdtemp(join(tmpdir(), "onetool-eval-"));
  const logFile = join(dir, "calls.jsonl");
  const mcpConfig = join(dir, "mcp.json");
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        eval: { command: process.execPath, args: [SERVER], env: { ONETOOL_EVAL_LAYOUT: options.layout, ONETOOL_EVAL_PADDING: String(options.padding), ONETOOL_EVAL_LOG: logFile } },
      },
    }),
  );
  try {
    const stdout = await exec("claude", cliArgs(options, mcpConfig), dir);
    return toEpisode(JSON.parse(stdout) as CliJson, await readLog(logFile));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Only the served MCP tools are available: built-ins off, our own system prompt, no session on disk. */
function cliArgs(options: ClaudeCodeOptions, mcpConfig: string): string[] {
  return [
    "-p", options.prompt,
    "--output-format", "json",
    "--model", options.model,
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--allowedTools", "mcp__eval__*",
    "--tools", "",
    "--system-prompt", options.system,
    "--max-turns", String(options.maxTurns ?? 12),
    "--no-session-persistence",
  ];
}

const EMPTY_USAGE = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
const EMPTY_JSON = { result: "", stop_reason: "unknown", is_error: false, num_turns: 0, total_cost_usd: 0, duration_api_ms: 0 };

function toEpisode(json: CliJson, calls: LoggedCall[]): ClaudeCodeEpisode {
  const j = { ...EMPTY_JSON, ...json };
  const usage = { ...EMPTY_USAGE, ...json.usage };
  return {
    finalText: j.result,
    stopReason: j.stop_reason,
    isError: j.is_error,
    numTurns: j.num_turns,
    usage: { input: usage.input_tokens, cacheCreate: usage.cache_creation_input_tokens, cacheRead: usage.cache_read_input_tokens, output: usage.output_tokens },
    costUsd: j.total_cost_usd,
    durationMs: j.duration_api_ms,
    calls,
  };
}

async function readLog(file: string): Promise<LoggedCall[]> {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LoggedCall);
  } catch {
    return [];
  }
}

function exec(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDECODE: "" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited with ${code}: ${(err || out).slice(0, 800)}`))));
  });
}
