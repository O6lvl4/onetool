import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  cleanText,
  isPlainObject,
  OperationError,
  type ExecuteContext,
  type JsonSchema,
  type Kind,
  type NamespaceInfo,
  type OperationRef,
  type OperationSpec,
  type OperationSummary,
  type Provider,
} from "@o6lvl4/onetool-core";

/** One upstream MCP server. Give either a connected `client` or how to start one. */
export type McpUpstream =
  | { name: string; summary?: string; client: Client }
  | { name: string; summary?: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { name: string; summary?: string; url: string; headers?: Record<string, string> };

interface Connected {
  upstream: McpUpstream;
  client: Client;
  tools: Map<string, Tool> | undefined;
}

/**
 * Aggregates MCP servers. Each upstream is a namespace; each of its tools is an operation whose
 * input schema is the tool's own. Kind comes from the tool's annotations, so a host sees
 * one policy-gated surface instead of N servers' worth of tools.
 */
export class McpProvider implements Provider {
  private readonly upstreams: McpUpstream[];
  private readonly clientInfo: { name: string; version: string };
  private readonly connections = new Map<string, Promise<Connected>>();

  constructor(upstreams: McpUpstream[], clientInfo = { name: "onetool", version: "0.1.0" }) {
    this.clientInfo = clientInfo;
    const names = new Set<string>();
    for (const u of upstreams) {
      if (names.has(u.name)) throw new Error(`McpProvider: upstream "${u.name}" is listed twice`);
      names.add(u.name);
    }
    this.upstreams = upstreams;
  }

  async namespaces(): Promise<NamespaceInfo[]> {
    return Promise.all(this.upstreams.map((u) => this.describeUpstream(u)));
  }

  private async describeUpstream(upstream: McpUpstream): Promise<NamespaceInfo> {
    const { client } = await this.connect(upstream.name);
    const server = client.getServerVersion();
    const instructions = cleanText(client.getInstructions(), 200);
    return { name: upstream.name, summary: upstream.summary ?? (instructions || `${server?.name ?? "MCP server"} ${server?.version ?? ""}`.trim()) };
  }

  async operations(namespace: string): Promise<OperationSummary[]> {
    const tools = await this.tools(namespace);
    return tools ? [...tools.values()].map((t) => summaryOf(namespace, t)) : [];
  }

  async operation(ref: OperationRef): Promise<OperationSpec | undefined> {
    const tool = (await this.tools(ref.namespace))?.get(ref.name);
    if (!tool) return undefined;
    const outputSchema = tool.outputSchema as JsonSchema | undefined;
    return {
      ...summaryOf(ref.namespace, tool),
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: tool.inputSchema as JsonSchema,
      ...(outputSchema ? { outputSchema } : {}),
    };
  }

  async execute(ref: OperationRef, input: Record<string, unknown>, ctx: ExecuteContext): Promise<unknown> {
    const { client } = await this.connect(ref.namespace);
    const result = (await client.callTool({ name: ref.name, arguments: input }, undefined, { ...(ctx.signal ? { signal: ctx.signal } : {}) })) as CallToolResult;
    const value = resultValue(result);
    if (result.isError) throw new OperationError(typeof value === "string" ? value : `${ref.namespace}:${ref.name} reported an error`, value);
    return value;
  }

  /** Disconnect every upstream this provider started. Clients passed in are left to their owner. */
  async close(): Promise<void> {
    for (const [name, pending] of this.connections) {
      const { upstream, client } = await pending;
      if (!("client" in upstream)) await client.close();
      this.connections.delete(name);
    }
  }

  private async tools(namespace: string): Promise<Map<string, Tool> | undefined> {
    if (!this.upstreams.some((u) => u.name === namespace)) return undefined;
    const connection = await this.connect(namespace);
    if (!connection.tools) {
      const { tools } = await connection.client.listTools();
      connection.tools = new Map(tools.map((t) => [t.name, t]));
    }
    return connection.tools;
  }

  private connect(namespace: string): Promise<Connected> {
    const upstream = this.upstreams.find((u) => u.name === namespace);
    if (!upstream) return Promise.reject(new Error(`McpProvider: unknown upstream "${namespace}"`));
    let pending = this.connections.get(namespace);
    if (!pending) {
      pending = this.open(upstream);
      this.connections.set(namespace, pending);
    }
    return pending;
  }

  private async open(upstream: McpUpstream): Promise<Connected> {
    const client = "client" in upstream ? upstream.client : new Client(this.clientInfo);
    if (!("client" in upstream)) await client.connect(transportFor(upstream));
    const connection: Connected = { upstream, client, tools: undefined };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      connection.tools = undefined;
    });
    return connection;
  }
}

function transportFor(upstream: McpUpstream): Transport {
  if ("url" in upstream) {
    return new StreamableHTTPClientTransport(new URL(upstream.url), upstream.headers ? { requestInit: { headers: upstream.headers } } : {}) as Transport;
  }
  if ("command" in upstream) {
    return new StdioClientTransport({
      command: upstream.command,
      args: upstream.args ?? [],
      ...(upstream.env ? { env: { ...(process.env as Record<string, string>), ...upstream.env } } : {}),
      ...(upstream.cwd ? { cwd: upstream.cwd } : {}),
      stderr: "inherit",
    }) as Transport;
  }
  throw new Error("McpProvider: upstream needs a client, a command or a url");
}

/** readOnlyHint decides read; everything else is a write unless the server explicitly says it is not destructive. */
function kindOf(tool: Tool): Kind {
  const a = tool.annotations;
  if (a?.readOnlyHint === true) return "read";
  return "write";
}

function summaryOf(namespace: string, tool: Tool): OperationSummary {
  const summary = cleanText(tool.title ?? tool.description ?? tool.name, 160);
  return { namespace, name: tool.name, summary, kind: kindOf(tool) };
}

/** Prefer structured content; otherwise a single text block (parsed as JSON when it is JSON); otherwise the raw blocks. */
function resultValue(result: CallToolResult): unknown {
  if (isPlainObject(result.structuredContent)) return result.structuredContent;
  const blocks = result.content ?? [];
  if (blocks.length === 1 && blocks[0]?.type === "text") {
    const text = blocks[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return blocks;
}
