import { cleanText, type JsonSchema, type Kind, type OperationSpec } from "@o6lvl4/onetool-core";
import { inlineRefs, resolve } from "./refs.js";
import { METHODS, type Method, type OpenApiDocument, type Operation, type Parameter, type ParameterLocation, type PathItem } from "./types.js";

export interface BoundParameter {
  /** Key in the flattened input object. */
  property: string;
  /** Name on the wire. Differs from `property` only when two locations share a name. */
  name: string;
  in: ParameterLocation;
}

export interface CompiledOperation {
  spec: OperationSpec;
  method: Method;
  path: string;
  parameters: BoundParameter[];
  body?: { contentType: string };
}

export interface CompileOptions {
  namespace: string;
  includeDeprecated: boolean;
}

/** Walk `paths` × methods and compile each operation once. Throws on duplicate operation names. */
export function compileDocument(doc: OpenApiDocument, options: CompileOptions): Map<string, CompiledOperation> {
  const ops = new Map<string, CompiledOperation>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op || (op.deprecated && !options.includeDeprecated)) continue;
      const name = op.operationId ?? nameFromPath(method, path);
      if (ops.has(name)) throw new Error(`OpenApiProvider: operation "${name}" appears twice (${method.toUpperCase()} ${path})`);
      ops.set(name, compileOperation({ doc, namespace: options.namespace, name, method, path, item, op }));
    }
  }
  return ops;
}

interface Site {
  doc: OpenApiDocument;
  namespace: string;
  name: string;
  method: Method;
  path: string;
  item: PathItem;
  op: Operation;
}

function compileOperation(site: Site): CompiledOperation {
  const { doc, namespace, name, method, path, item, op } = site;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const parameters = bindParameters(doc, [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(doc, p)), properties, required);
  const body = bindBody(doc, op, properties, required);
  const spec: OperationSpec = {
    namespace,
    name,
    summary: cleanText(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`, 160),
    description: describe(method, path, op),
    kind: kindOf(op, method),
    ...(op.tags?.length ? { tags: op.tags } : {}),
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
    outputSchema: outputSchemaOf(doc, op),
  };
  return { spec, method, path, parameters, ...(body ? { body } : {}) };
}

/**
 * `execute` always returns `{ status, body }`, so the output schema is that envelope with the body
 * taken from the first successful JSON response (200, 201, then any 2xx, then `default`).
 */
function outputSchemaOf(doc: OpenApiDocument, op: Operation): JsonSchema {
  const responses = op.responses ?? {};
  const codes = Object.keys(responses);
  const chosen = ["200", "201"].find((c) => c in responses) ?? codes.find((c) => /^2/.test(c)) ?? codes.find((c) => c === "default");
  const response = chosen ? resolve(doc, responses[chosen] as NonNullable<Operation["responses"]>[string]) : undefined;
  const content = response?.content ?? {};
  const jsonType = Object.keys(content).find((t) => t.includes("json"));
  const bodySchema = jsonType ? inlineRefs(doc, content[jsonType]?.schema ?? {}) : {};
  const body = { ...bodySchema, ...(response?.description ? { description: cleanText(response.description, 300) } : {}) };
  return { type: "object", properties: { status: { type: "integer", description: "HTTP status code" }, body }, required: ["status", "body"] };
}

/** `x-onetool-kind` wins; otherwise GET and HEAD read, everything else writes. */
function kindOf(op: Operation, method: Method): Kind {
  if (op["x-onetool-kind"]) return op["x-onetool-kind"];
  return method === "get" || method === "head" ? "read" : "write";
}

/** Path-level parameters first, operation-level ones override by (location, name). */
function bindParameters(doc: OpenApiDocument, params: Parameter[], properties: Record<string, JsonSchema>, required: string[]): BoundParameter[] {
  const merged = new Map<string, Parameter>();
  for (const p of params) merged.set(`${p.in}:${p.name}`, p);
  const bound: BoundParameter[] = [];
  for (const p of merged.values()) {
    const property = propertyName(p, properties);
    properties[property] = parameterSchema(doc, p);
    if (p.required || p.in === "path") required.push(property);
    bound.push({ property, name: p.name, in: p.in });
  }
  return bound;
}

function propertyName(p: Parameter, taken: Record<string, JsonSchema>): string {
  return p.name in taken ? `${p.name}_${p.in}` : p.name;
}

function parameterSchema(doc: OpenApiDocument, p: Parameter): JsonSchema {
  const schema = inlineRefs(doc, p.schema ?? { type: "string" });
  const text = cleanText(p.description, 300);
  return { ...schema, description: text ? `(${p.in}) ${text}` : `(${p.in})` };
}

function bindBody(doc: OpenApiDocument, op: Operation, properties: Record<string, JsonSchema>, required: string[]): CompiledOperation["body"] {
  const requestBody = op.requestBody ? resolve(doc, op.requestBody) : undefined;
  const content = requestBody?.content;
  if (!content) return undefined;
  const contentType = pickContentType(Object.keys(content));
  if (!contentType) return undefined;
  const schema = inlineRefs(doc, content[contentType]?.schema ?? { type: "object" });
  const description = cleanText(requestBody.description, 300);
  properties["body"] = { ...schema, ...(description ? { description: `(request body, ${contentType}) ${description}` } : {}) };
  if (requestBody.required) required.push("body");
  return { contentType };
}

/** JSON first, then form encoding, then whatever the document lists first. */
function pickContentType(types: string[]): string | undefined {
  return types.find((t) => t.includes("json")) ?? types.find((t) => t.includes("x-www-form-urlencoded")) ?? types[0];
}

function describe(method: Method, path: string, op: Operation): string {
  const head = `${method.toUpperCase()} ${path}`;
  const detail = op.description ? cleanText(op.description, 1500) : cleanText(op.summary, 300);
  return detail ? `${head} — ${detail}` : head;
}

/** `get` + `/pets/{petId}` → `get_pets_by_petId`, used only when an operation has no operationId. */
export function nameFromPath(method: Method, path: string): string {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? `by_${seg.slice(1, -1)}` : seg.replace(/[^A-Za-z0-9]+/g, "_")));
  return [method, ...parts].join("_");
}
