#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OneTool, type OneToolOptions, type PolicyConfig } from "@o6lvl4/onetool-core";
import { McpProvider, type McpUpstream } from "@o6lvl4/onetool-provider-mcp";
import { OpenApiProvider, type OpenApiDocument } from "@o6lvl4/onetool-provider-openapi";
import { createOneToolServer, VERSION } from "./index.js";

const USAGE = `onetool-mcp ${VERSION} — one MCP server, four tools, any API behind them.

Usage:
  onetool-mcp <config.mjs>                       load OneToolOptions from a module (default export: object or async function)
  onetool-mcp --openapi <file|url> [options]      front an OpenAPI 3.x document without writing code
  onetool-mcp --upstream <name>=<command...> ...  aggregate other MCP servers (stdio); repeat for several
  onetool-mcp --upstream <name>=<http(s) url> ... aggregate a Streamable HTTP MCP server

Options (OpenAPI mode):
  --base-url <url>       override servers[0].url
  --header "Name: value" add a request header (repeatable; use for Authorization)
  --namespace <name>     namespace name (default: slug of info.title)
Options (both modes):
  --policy <file.json>   PolicyConfig (allow / confirm / deny / sensitive patterns, mode, onNoConfirm)
  --strict               shorthand for policy mode "strict"
  --prefix <name>        tool name prefix (default "api")
  --name <name>          MCP server name

The server speaks MCP over stdio; logs go to stderr.
`;

interface Args {
  config?: string;
  openapi?: string;
  upstreams: McpUpstream[];
  baseUrl?: string;
  headers: Record<string, string>;
  namespace?: string;
  policy?: string;
  strict: boolean;
  prefix?: string;
  name?: string;
  help: boolean;
}

type Setter = (args: Args, value: string) => void;

/** Options that take a value. Flags without a value are handled separately. */
const VALUED: Record<string, Setter> = {
  "--openapi": (a, v) => (a.openapi = v),
  "--base-url": (a, v) => (a.baseUrl = v),
  "--namespace": (a, v) => (a.namespace = v),
  "--policy": (a, v) => (a.policy = v),
  "--prefix": (a, v) => (a.prefix = v),
  "--name": (a, v) => (a.name = v),
  "--upstream": (a, v) => {
    const eq = v.indexOf("=");
    if (eq < 0) throw new Error(`--upstream expects "name=command args" or "name=url", got "${v}"`);
    const name = v.slice(0, eq).trim();
    const target = v.slice(eq + 1).trim();
    if (/^https?:\/\//.test(target)) {
      a.upstreams.push({ name, url: target });
    } else {
      const [command, ...args] = target.split(/\s+/);
      if (!command) throw new Error(`--upstream ${name}: empty command`);
      a.upstreams.push({ name, command, args });
    }
  },
  "--header": (a, v) => {
    const colon = v.indexOf(":");
    if (colon < 0) throw new Error(`--header expects "Name: value", got "${v}"`);
    a.headers[v.slice(0, colon).trim()] = v.slice(colon + 1).trim();
  },
};

const FLAGS: Record<string, (args: Args) => void> = {
  "--strict": (a) => (a.strict = true),
  "--help": (a) => (a.help = true),
  "-h": (a) => (a.help = true),
};

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { headers: {}, upstreams: [], strict: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    const flag = FLAGS[token];
    const setter = VALUED[token];
    if (flag) {
      flag(args);
    } else if (setter) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} needs a value`);
      setter(args, value);
    } else if (token.startsWith("-")) {
      throw new Error(`unknown option ${token}`);
    } else {
      args.config = token;
    }
  }
  return args;
}

async function loadJson(target: string): Promise<unknown> {
  if (/^https?:\/\//.test(target)) {
    const res = await fetch(target);
    if (!res.ok) throw new Error(`${target}: HTTP ${res.status}`);
    return res.json();
  }
  const text = await readFile(resolve(target), "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${target}: not JSON (YAML documents must be converted to JSON first)`);
  }
}

async function optionsFromOpenApi(args: Args, source: string): Promise<OneToolOptions> {
  const document = (await loadJson(source)) as OpenApiDocument;
  const provider = new OpenApiProvider({
    document,
    ...(/^https?:\/\//.test(source) ? { documentUrl: source } : {}),
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.namespace ? { namespace: args.namespace } : {}),
    ...(Object.keys(args.headers).length ? { headers: args.headers } : {}),
  });
  return { providers: [provider], title: document.info?.title ?? "the API" };
}

async function optionsFromConfig(path: string): Promise<OneToolOptions> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  const loaded = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default;
  if (!loaded || typeof loaded !== "object" || !Array.isArray((loaded as OneToolOptions).providers)) {
    throw new Error(`${path}: default export must be OneToolOptions with a "providers" array`);
  }
  return loaded as OneToolOptions;
}

async function applyOverrides(options: OneToolOptions, args: Args): Promise<OneToolOptions> {
  const policy: PolicyConfig | undefined = args.policy ? ((await loadJson(args.policy)) as PolicyConfig) : options.policy;
  const withMode = args.strict ? { ...(policy ?? {}), mode: "strict" as const } : policy;
  return { ...options, ...(withMode ? { policy: withMode } : {}), ...(args.prefix ? { prefix: args.prefix } : {}) };
}

export async function buildOptions(args: Args): Promise<OneToolOptions> {
  if (args.upstreams.length > 0) {
    const title = args.upstreams.length === 1 ? `the ${args.upstreams[0]?.name} MCP server` : `${args.upstreams.length} MCP servers`;
    return applyOverrides({ providers: [new McpProvider(args.upstreams)], title }, args);
  }
  if (args.openapi) return applyOverrides(await optionsFromOpenApi(args, args.openapi), args);
  if (args.config) return applyOverrides(await optionsFromConfig(args.config), args);
  throw new Error(`give a config module, --openapi or --upstream\n\n${USAGE}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const onetool = new OneTool(await buildOptions(args));
  const server = createOneToolServer(onetool, { ...(args.name ? { name: args.name } : {}) });
  await server.connect(new StdioServerTransport());
  const names = (await onetool.services()).map((n) => n.name).join(", ");
  process.stderr.write(`onetool-mcp: serving ${onetool.toolSpecs().map((t) => t.name).join(", ")} for namespace(s) ${names}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`onetool-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
