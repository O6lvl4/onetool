import { normalizeName } from "./policy.js";
import type { NamespaceInfo, OperationRef, OperationSpec, Provider } from "./types.js";

/** Thrown when a namespace or operation name cannot be matched. Carries close matches for the model. */
export class ResolveError extends Error {
  readonly candidates: string[];

  constructor(message: string, candidates: string[] = []) {
    super(message);
    this.name = "ResolveError";
    this.candidates = candidates;
  }
}

export interface NamespaceEntry {
  info: NamespaceInfo;
  provider: Provider;
}

export interface Resolved {
  spec: OperationSpec;
  ref: OperationRef;
  provider: Provider;
}

export async function buildIndex(providers: Provider[]): Promise<Map<string, NamespaceEntry>> {
  const index = new Map<string, NamespaceEntry>();
  for (const provider of providers) {
    for (const info of await provider.namespaces()) {
      if (index.has(info.name)) throw new Error(`namespace "${info.name}" is provided twice`);
      index.set(info.name, { info, provider });
    }
  }
  return index;
}

/** Exact name, then a name that only differs in case / `-` / `_`, then an error listing what exists. */
export function pickNamespace(index: Map<string, NamespaceEntry>, name: string | undefined): NamespaceEntry {
  if (name === undefined) return soleNamespace(index);
  const exact = index.get(name);
  if (exact) return exact;
  const wanted = normalizeName(name);
  for (const [key, entry] of index) if (normalizeName(key) === wanted) return entry;
  const available = [...index.keys()];
  throw new ResolveError(`unknown namespace "${name}"; available: ${available.join(", ")}`, similar(available, wanted));
}

function soleNamespace(index: Map<string, NamespaceEntry>): NamespaceEntry {
  const entries = [...index.values()];
  const only = entries[0];
  if (entries.length === 1 && only) return only;
  const names = [...index.keys()];
  throw new ResolveError(`namespace is required; available: ${names.join(", ")}`, names);
}

/** Exact operation name first, then the same name in another casing convention (`list_pets` → `listPets`). */
export async function resolveOperation(entry: NamespaceEntry, operation: string, listTool: string): Promise<Resolved> {
  const { info, provider } = entry;
  const direct = await provider.operation({ namespace: info.name, name: operation });
  if (direct) return { spec: direct, ref: { namespace: info.name, name: direct.name }, provider };

  const all = await provider.operations(info.name);
  const wanted = normalizeName(operation);
  const match = all.find((op) => normalizeName(op.name) === wanted);
  const spec = match ? await provider.operation({ namespace: info.name, name: match.name }) : undefined;
  if (spec) return { spec, ref: { namespace: info.name, name: spec.name }, provider };

  const candidates = similar(all.map((op) => op.name), wanted).slice(0, 8);
  const hint = candidates.length > 0 ? `did you mean: ${candidates.join(", ")}` : `use ${listTool} to list them`;
  throw new ResolveError(`unknown operation "${operation}" in namespace "${info.name}"; ${hint}`, candidates);
}

function similar(names: string[], wanted: string): string[] {
  return names.filter((name) => {
    const normalized = normalizeName(name);
    return normalized.includes(wanted) || wanted.includes(normalized);
  });
}

export function matchesQuery(query: string, ...fields: string[]): boolean {
  const q = query.toLowerCase();
  return fields.some((field) => field.toLowerCase().includes(q));
}
