import { flatToolName, flatToolSpec } from "./flat.js";
import type { OneTool } from "./onetool.js";
import type { Layout, OperationRef, ToolSpec } from "./types.js";

export interface SurfaceOptions {
  layout: Layout;
  autoThreshold: number;
  /** 0 disables the inline catalog. */
  catalogChars: number;
}

export interface ResolvedTools {
  layout: "generic" | "flat";
  specs: ToolSpec[];
}

/** Which layout applies right now: `auto` counts the operations and compares with the threshold. */
export async function effectiveLayout(onetool: OneTool, options: SurfaceOptions): Promise<"generic" | "flat"> {
  if (options.layout !== "auto") return options.layout;
  let count = 0;
  for (const ns of await onetool.services()) count += (await onetool.operations(ns.name)).length;
  return count <= options.autoThreshold ? "flat" : "generic";
}

/** The four generic tools, with the catalog folded into the call tool's description when enabled. */
export async function genericSpecs(onetool: OneTool, catalogChars: number): Promise<ToolSpec[]> {
  const specs = onetool.toolSpecs();
  if (catalogChars <= 0) return specs;
  const catalog = await catalogText(onetool, catalogChars);
  return specs.map((spec) => (spec.name === `${onetool.prefix}_call` ? { ...spec, description: withCatalog(spec.description, catalog) } : spec));
}

/** One tool per operation, annotated from the classified kind. */
export async function flatSpecs(onetool: OneTool, names: Map<string, OperationRef>): Promise<ToolSpec[]> {
  const specs: ToolSpec[] = [];
  for (const [name, ref] of names) {
    const { spec, kind } = await onetool.describe(ref.namespace, ref.name);
    specs.push(flatToolSpec(name, { ...spec, kind }));
  }
  return specs;
}

/** Flat tool name → operation. A clash after sanitising gets a numeric suffix. */
export async function flatNames(onetool: OneTool): Promise<Map<string, OperationRef>> {
  const index = new Map<string, OperationRef>();
  for (const ns of await onetool.services()) {
    for (const op of await onetool.operations(ns.name)) {
      const ref = { namespace: ns.name, name: op.name };
      let name = flatToolName(ref);
      for (let n = 2; index.has(name); n++) name = `${flatToolName(ref).slice(0, 60)}_${n}`;
      index.set(name, ref);
    }
  }
  return index;
}

/** One line per namespace: `namespace: op — summary; op — summary`, cut at `maxChars` with a pointer to the list tool. */
export async function catalogText(onetool: OneTool, maxChars: number): Promise<string> {
  const lines: string[] = [];
  let omitted = 0;
  let used = 0;
  for (const ns of await onetool.services()) {
    const entries = (await onetool.operations(ns.name)).map((op) => `${op.name} — ${op.summary}`);
    const line = `${ns.name}: ${entries.join("; ")}`;
    if (used + line.length + 1 > maxChars) {
      omitted += entries.length;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) lines.push(`(${omitted} more operations; use ${onetool.prefix}_operations to list them)`);
  return lines.join("\n");
}

function withCatalog(description: string, catalog: string): string {
  return `${description} Call directly when you know the operation: an unknown name returns candidates and invalid input returns the schema, so calling first is usually faster than listing or describing.\nOperations (namespace: name — summary):\n${catalog}`;
}
