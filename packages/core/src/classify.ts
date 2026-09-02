import type { Kind, OperationSummary } from "./types.js";

/**
 * Leading verbs that mean "this only reads". Matched on the first word of the operation name
 * (camelCase, PascalCase and snake_case are all split into words), never as a substring:
 * `describeAddresses` is read; `addTags` is not, even though it contains "add".
 */
const READ_VERBS = new Set([
  "list", "get", "describe", "search", "query", "lookup", "head", "scan", "select", "check", "test",
  "validate", "preview", "estimate", "simulate", "verify", "discover", "count", "resolve", "detect",
  "is", "can", "has", "filter", "retrieve", "view", "read", "poll", "peek", "find", "fetch", "show", "exists",
]);

/** Split an identifier into lowercase words: `batchGetItem` → [batch, get, item], `list_pets` → [list, pets]. */
export function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-./]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Infer a kind from the operation name alone. Anything not recognised as a read is treated as a write. */
export function kindFromName(name: string): Kind {
  const [first, second] = words(name);
  if (first && READ_VERBS.has(first)) return "read";
  if (first === "batch" && second && READ_VERBS.has(second)) return "read";
  return "write";
}

/** Provider-declared kind wins; otherwise fall back to the name heuristic. */
export function classify(op: Pick<OperationSummary, "name" | "kind">): Kind {
  return op.kind ?? kindFromName(op.name);
}
