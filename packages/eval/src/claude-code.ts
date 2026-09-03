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
import type { LoggedCall } from "./mcp-server.js";

export interface ClaudeCodeOptions {
  model: string;
  layout: "onetool" | "flat";
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
      mcpServers: { eval: { command: process.execPath, args: [SERVER], env: { ONETOOL_EVAL_LAYOUT: options.layout, ONETOOL_EVAL_LOG: logFile } } },
    }),
  );
  const args = [
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
  try {
    const stdout = await exec("claude", args, dir);
    const json = JSON.parse(stdout) as CliJson;
    const calls = await readLog(logFile);
    return {
      finalText: json.result ?? "",
      stopReason: json.stop_reason ?? "unknown",
      isError: json.is_error ?? false,
      numTurns: json.num_turns ?? 0,
      usage: {
        input: json.usage?.input_tokens ?? 0,
        cacheCreate: json.usage?.cache_creation_input_tokens ?? 0,
        cacheRead: json.usage?.cache_read_input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
      },
      costUsd: json.total_cost_usd ?? 0,
      durationMs: json.duration_api_ms ?? 0,
      calls,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
