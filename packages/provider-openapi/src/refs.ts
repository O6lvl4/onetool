import { isPlainObject, type JsonSchema } from "@o6lvl4/onetool-core";
import type { OpenApiDocument, Ref } from "./types.js";

const MAX_REF_DEPTH = 12;

export function isRef(value: unknown): value is Ref {
  return isPlainObject(value) && typeof value["$ref"] === "string";
}

/** Resolve a local JSON pointer such as `#/components/schemas/Pet`. Remote refs are not supported. */
export function deref(doc: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`OpenApiProvider: only local $ref is supported, got "${ref}"`);
  let node: unknown = doc;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainObject(node) || !(key in node)) throw new Error(`OpenApiProvider: unresolvable $ref "${ref}"`);
    node = node[key];
  }
  return node;
}

/** Resolve a value that may be a `$ref` to whatever it points at. */
export function resolve<T>(doc: OpenApiDocument, value: T | Ref): T {
  return isRef(value) ? (deref(doc, value.$ref) as T) : value;
}

/** Inline every local $ref so the model receives a self-contained schema. Cycles collapse to a placeholder. */
export function inlineRefs(doc: OpenApiDocument, schema: JsonSchema, stack: readonly string[] = []): JsonSchema {
  if (isRef(schema)) return inlineRef(doc, schema.$ref, stack);
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) out[key] = inlineChild(doc, key, value, stack);
  return out;
}

function inlineRef(doc: OpenApiDocument, ref: string, stack: readonly string[]): JsonSchema {
  const shortName = ref.split("/").pop() ?? ref;
  if (stack.includes(ref) || stack.length > MAX_REF_DEPTH) {
    return { type: "object", description: `${shortName} (recursive; see ${shortName} above)` };
  }
  const target = deref(doc, ref);
  return isPlainObject(target) ? inlineRefs(doc, target, [...stack, ref]) : {};
}

const SCHEMA_MAP_KEYS = new Set(["properties"]);
const SCHEMA_KEYS = new Set(["items", "additionalProperties", "not"]);
const SCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "oneOf"]);

function inlineChild(doc: OpenApiDocument, key: string, value: unknown, stack: readonly string[]): unknown {
  if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isPlainObject(v) ? inlineRefs(doc, v, stack) : v]));
  }
  if (SCHEMA_KEYS.has(key) && isPlainObject(value)) return inlineRefs(doc, value, stack);
  if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) return value.map((v) => (isPlainObject(v) ? inlineRefs(doc, v, stack) : v));
  return value;
}
