#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OneTool, type OneToolOptions, type PolicyConfig } from "@o6lvl4/onetool-core";
import { OpenApiProvider, type OpenApiDocument } from "@o6lvl4/onetool-provider-openapi";
import { createOneToolServer, VERSION } from "./index.js";

const USAGE = `onetool-mcp ${VERSION} — one MCP server, four tools, any API behind them.

Usage:
  onetool-mcp <config.mjs>                       load OneToolOptions from a module (default export: object or async function)
  onetool-mcp --openapi <file|url> [options]      front an OpenAPI 3.x document without writing code

Options (OpenAPI mode):
  --base-url <url>       override servers[0].url
  --header "Name: value" add a request header (repeatable; use for Authorization)
  --namespace <name>     namespace name (default: slug of info.title)
Options (both modes):
  --policy <file.json>   PolicyConfig (allow / confirm / deny / sensitive patterns, mode, onNoConfirm)
  --strict               shorthand for policy mode "strict"
  --prefix <name>        tool name prefix (default "api")
  --name <name>          MCP server name

The server speaks MCP over stdio; logs go to stderr.`;

interface Args {
  config?: string;
  openapi?: string;
  baseUrl?: string;
  headers: Record<string, string>;
  namespace?: string;
  policy?: string;
  strict: boolean;
  prefix?: string;
  name?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { headers: {}, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--openapi": args.openapi = next(); break;
      case "--base-url": args.baseUrl = next(); break;
      case "--header": {
        const raw = next();
        const colon = raw.indexOf(":");
        if (colon < 0) throw new Error(`--header expects "Name: value", got "${raw}"`);
        args.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
        break;
      }
      case "--namespace": args.namespace = next(); break;
      case "--policy": args.policy = next(); break;
      case "--strict": args.strict = true; break;
      case "--prefix": args.prefix = next(); break;
      case "--name": args.name = next(); break;
      case "-h": case "--help": console.log(USAGE); process.exit(0);
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        args.config = a;
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

async function buildOptions(args: Args): Promise<OneToolOptions> {
  let options: OneToolOptions;
  if (args.openapi) {
    const document = (await loadJson(args.openapi)) as OpenApiDocument;
    const provider = new OpenApiProvider({
      document,
      ...(/^https?:\/\//.test(args.openapi) ? { documentUrl: args.openapi } : {}),
      ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      ...(args.namespace ? { namespace: args.namespace } : {}),
      ...(Object.keys(args.headers).length ? { headers: args.headers } : {}),
    });
    options = { providers: [provider], title: document.info?.title ?? "the API" };
  } else if (args.config) {
    const mod = (await import(pathToFileURL(resolve(args.config)).href)) as { default?: unknown };
    const loaded = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default;
    if (!loaded || typeof loaded !== "object" || !Array.isArray((loaded as OneToolOptions).providers)) {
      throw new Error(`${args.config}: default export must be OneToolOptions with a "providers" array`);
    }
    options = loaded as OneToolOptions;
  } else {
    throw new Error("give a config module or --openapi\n\n" + USAGE);
  }
  if (args.policy) options.policy = (await loadJson(args.policy)) as PolicyConfig;
  if (args.strict) options.policy = { ...(options.policy ?? {}), mode: "strict" };
  if (args.prefix) options.prefix = args.prefix;
  return options;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options = await buildOptions(args);
  const onetool = new OneTool(options);
  const server = createOneToolServer(onetool, { ...(args.name ? { name: args.name } : {}) });
  await server.connect(new StdioServerTransport());
  const names = (await onetool.services()).map((n) => n.name).join(", ");
  console.error(`onetool-mcp: serving ${onetool.toolSpecs().map((t) => t.name).join(", ")} for namespace(s) ${names}`);
}

main().catch((error: unknown) => {
  console.error(`onetool-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
