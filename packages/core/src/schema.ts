import type { JsonSchema } from "./types.js";

/** Strip HTML, collapse whitespace, cap length. Documentation strings from API models are often HTML. */
export function cleanText(text: string | undefined, max = 2000): string {
  if (!text) return "";
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/**
 * Validate a value against the practical subset of JSON Schema onetool understands.
 * Returns human-readable problems; an empty array means "no objection".
 * Unknown properties are only reported when the schema says `additionalProperties: false`.
 */
export function validate(schema: JsonSchema | undefined, value: unknown, path = "input"): string[] {
  if (!schema) return [];
  const problems: string[] = [];
  const declared = schema["type"];
  const types = Array.isArray(declared) ? (declared as string[]) : typeof declared === "string" ? [declared] : [];
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    return [`${path}: expected ${types.join(" | ")}, got ${describeValue(value)}`];
  }
  const allowed = schema["enum"];
  if (Array.isArray(allowed) && !allowed.some((candidate) => sameJson(candidate, value))) {
    problems.push(`${path}: must be one of ${JSON.stringify(allowed)}`);
  }
  if (isPlainObject(value)) {
    const props = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
    const required = (schema["required"] as string[] | undefined) ?? [];
    for (const name of required) {
      if (value[name] === undefined) problems.push(`${path}: missing required property "${name}"`);
    }
    const additional = schema["additionalProperties"];
    for (const [name, member] of Object.entries(value)) {
      if (member === undefined) continue;
      const sub = props[name];
      if (sub) {
        problems.push(...validate(sub, member, `${path}.${name}`));
      } else if (additional === false) {
        const valid = Object.keys(props);
        problems.push(`${path}: unknown property "${name}"${valid.length ? ` (valid: ${valid.join(", ")})` : ""}`);
      } else if (isPlainObject(additional)) {
        problems.push(...validate(additional, member, `${path}.${name}`));
      }
    }
  }
  const items = schema["items"];
  if (Array.isArray(value) && isPlainObject(items)) {
    value.forEach((item, i) => problems.push(...validate(items, item, `${path}[${i}]`)));
  }
  return problems;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
