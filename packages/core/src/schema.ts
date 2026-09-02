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
 * Validate a value against the practical subset of JSON Schema onetool understands:
 * type, enum, required, properties, additionalProperties and items.
 * Returns human-readable problems; an empty array means "no objection".
 * Unknown properties are only reported when the schema says `additionalProperties: false`.
 */
export function validate(schema: JsonSchema | undefined, value: unknown, path = "input"): string[] {
  if (!schema) return [];
  const wrongType = checkType(schema, value, path);
  if (wrongType) return [wrongType];
  return [...checkEnum(schema, value, path), ...checkObject(schema, value, path), ...checkArray(schema, value, path)];
}

function declaredTypes(schema: JsonSchema): string[] {
  const type = schema["type"];
  if (Array.isArray(type)) return type as string[];
  if (typeof type === "string") return [type];
  return [];
}

function checkType(schema: JsonSchema, value: unknown, path: string): string | undefined {
  const types = declaredTypes(schema);
  if (types.length === 0 || types.some((t) => matchesType(t, value))) return undefined;
  return `${path}: expected ${types.join(" | ")}, got ${describeValue(value)}`;
}

function checkEnum(schema: JsonSchema, value: unknown, path: string): string[] {
  const allowed = schema["enum"];
  if (!Array.isArray(allowed) || allowed.some((candidate) => sameJson(candidate, value))) return [];
  return [`${path}: must be one of ${JSON.stringify(allowed)}`];
}

function checkObject(schema: JsonSchema, value: unknown, path: string): string[] {
  if (!isPlainObject(value)) return [];
  const props = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
  const required = (schema["required"] as string[] | undefined) ?? [];
  const missing = required.filter((name) => value[name] === undefined).map((name) => `${path}: missing required property "${name}"`);
  const scope: ObjectScope = { props, additional: schema["additionalProperties"], path };
  const members = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .flatMap(([name, member]) => checkMember(scope, name, member));
  return [...missing, ...members];
}

interface ObjectScope {
  props: Record<string, JsonSchema>;
  additional: unknown;
  path: string;
}

function checkMember({ props, additional, path }: ObjectScope, name: string, member: unknown): string[] {
  const sub = props[name];
  if (sub) return validate(sub, member, `${path}.${name}`);
  if (additional === false) {
    const valid = Object.keys(props);
    return [`${path}: unknown property "${name}"${valid.length ? ` (valid: ${valid.join(", ")})` : ""}`];
  }
  return isPlainObject(additional) ? validate(additional, member, `${path}.${name}`) : [];
}

function checkArray(schema: JsonSchema, value: unknown, path: string): string[] {
  const items = schema["items"];
  if (!Array.isArray(value) || !isPlainObject(items)) return [];
  return value.flatMap((item, i) => validate(items, item, `${path}[${i}]`));
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
