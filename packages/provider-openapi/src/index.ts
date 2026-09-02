import {
  cleanText,
  InputValidationError,
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

/** The parts of an OpenAPI 3.x document this provider reads. Anything else is ignored. */
export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: { url: string }[];
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    parameters?: Record<string, Parameter>;
    requestBodies?: Record<string, RequestBody>;
  };
}

interface PathItem {
  parameters?: (Parameter | Ref)[];
  get?: Operation;
  put?: Operation;
  post?: Operation;
  delete?: Operation;
  patch?: Operation;
  head?: Operation;
  options?: Operation;
}

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: (Parameter | Ref)[];
  requestBody?: RequestBody | Ref;
  "x-onetool-kind"?: Kind;
}

interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: JsonSchema;
}

interface RequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: JsonSchema }>;
}

interface Ref {
  $ref: string;
}

type Method = "get" | "put" | "post" | "delete" | "patch" | "head" | "options";
const METHODS: Method[] = ["get", "put", "post", "delete", "patch", "head", "options"];

export interface OpenApiProviderOptions {
  document: OpenApiDocument;
  /** Namespace name. Defaults to a slug of `info.title`. */
  namespace?: string;
  summary?: string;
  /** Defaults to `servers[0].url`. Required when the document has no servers. */
  baseUrl?: string;
  /** Where the document was fetched from. A relative `servers[].url` (allowed by OpenAPI) is resolved against it. */
  documentUrl?: string;
  /** Static headers (for example `Authorization`) or a function producing them per call. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  fetch?: typeof fetch;
  /** Include operations marked `deprecated: true`. Default false. */
  includeDeprecated?: boolean;
}

interface BoundParameter {
  property: string;
  name: string;
  in: Parameter["in"];
}

interface CompiledOperation extends OperationSpec {
  method: Method;
  path: string;
  parameters: BoundParameter[];
  body?: { contentType: string };
}

/**
 * Turns an OpenAPI document into a onetool namespace. Each operation becomes
 * `{ path/query/header params..., body }` in one flat input object, so the model
 * never has to know where a parameter travels. Execution is a single fetch.
 */
export class OpenApiProvider implements Provider {
  readonly namespace: string;
  private readonly summary: string;
  private readonly baseUrl: string;
  private readonly headers: OpenApiProviderOptions["headers"];
  private readonly fetchFn: typeof fetch;
  private readonly ops: Map<string, CompiledOperation>;

  constructor(private readonly options: OpenApiProviderOptions) {
    const doc = options.document;
    this.namespace = options.namespace ?? slug(doc.info?.title ?? "api");
    this.baseUrl = resolveBaseUrl(options.baseUrl ?? doc.servers?.[0]?.url, options.documentUrl).replace(/\/+$/, "");
    this.headers = options.headers;
    this.fetchFn = options.fetch ?? fetch;
    this.ops = this.compile(doc);
    this.summary = options.summary ?? (cleanText(doc.info?.description, 200) || `${doc.info?.title ?? "API"} (${this.ops.size} operations)`);
  }

  async namespaces(): Promise<NamespaceInfo[]> {
    return [{ name: this.namespace, summary: this.summary }];
  }

  async operations(namespace: string): Promise<OperationSummary[]> {
    if (namespace !== this.namespace) return [];
    return [...this.ops.values()].map(({ namespace: ns, name, summary, kind, tags }) => ({
      namespace: ns,
      name,
      summary,
      ...(kind ? { kind } : {}),
      ...(tags ? { tags } : {}),
    }));
  }

  async operation(ref: OperationRef): Promise<OperationSpec | undefined> {
    if (ref.namespace !== this.namespace) return undefined;
    const op = this.ops.get(ref.name);
    if (!op) return undefined;
    const { method: _m, path: _p, parameters: _params, body: _b, ...spec } = op;
    return spec;
  }

  async execute(ref: OperationRef, input: Record<string, unknown>, ctx: ExecuteContext): Promise<unknown> {
    const op = this.ops.get(ref.name);
    if (!op || ref.namespace !== this.namespace) throw new Error(`unknown operation ${ref.namespace}:${ref.name}`);

    let path = op.path;
    const query = new URLSearchParams();
    const headers: Record<string, string> = { accept: "application/json, text/*;q=0.8, */*;q=0.5" };
    for (const p of op.parameters) {
      const value = input[p.property];
      if (value === undefined || value === null) continue;
      switch (p.in) {
        case "path":
          path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
          break;
        case "query":
          for (const v of Array.isArray(value) ? value : [value]) query.append(p.name, typeof v === "object" ? JSON.stringify(v) : String(v));
          break;
        case "header":
          headers[p.name] = String(value);
          break;
        case "cookie":
          headers["cookie"] = `${headers["cookie"] ? `${headers["cookie"]}; ` : ""}${p.name}=${encodeURIComponent(String(value))}`;
          break;
      }
    }
    const configured = typeof this.headers === "function" ? await this.headers() : (this.headers ?? {});
    Object.assign(headers, configured);

    let body: string | undefined;
    if (op.body && input["body"] !== undefined) {
      if (op.body.contentType.includes("x-www-form-urlencoded")) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(input["body"] as Record<string, unknown>)) form.append(k, String(v));
        body = form.toString();
      } else {
        body = JSON.stringify(input["body"]);
      }
      headers["content-type"] = op.body.contentType;
    }

    const qs = query.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const response = await this.fetchFn(url, {
      method: op.method.toUpperCase(),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const parsed = await parseBody(response);
    if (response.status === 400 || response.status === 422) {
      throw new InputValidationError([`HTTP ${response.status} from ${op.method.toUpperCase()} ${op.path}: ${stringify(parsed)}`]);
    }
    if (!response.ok) {
      throw new OperationError(`HTTP ${response.status} ${response.statusText} from ${op.method.toUpperCase()} ${op.path}`, parsed);
    }
    return { status: response.status, body: parsed };
  }

  // ---- compilation ---------------------------------------------------------------------

  private compile(doc: OpenApiDocument): Map<string, CompiledOperation> {
    const ops = new Map<string, CompiledOperation>();
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        if (op.deprecated && !this.options.includeDeprecated) continue;
        const name = op.operationId ?? nameFromPath(method, path);
        if (ops.has(name)) throw new Error(`OpenApiProvider: operation "${name}" appears twice (${method.toUpperCase()} ${path})`);
        ops.set(name, this.compileOperation(doc, name, method, path, item, op));
      }
    }
    return ops;
  }

  private compileOperation(doc: OpenApiDocument, name: string, method: Method, path: string, item: PathItem, op: Operation): CompiledOperation {
    const resolveParam = (p: Parameter | Ref): Parameter => (isRef(p) ? (deref(doc, p.$ref) as Parameter) : p);
    const merged = new Map<string, Parameter>();
    for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolveParam)) merged.set(`${p.in}:${p.name}`, p);

    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const parameters: BoundParameter[] = [];
    const used = new Set<string>();
    for (const p of merged.values()) {
      const property = used.has(p.name) ? `${p.name}_${p.in}` : p.name;
      used.add(property);
      const schema = { ...inlineRefs(doc, p.schema ?? { type: "string" }) };
      const description = cleanText(p.description, 300);
      properties[property] = { ...schema, ...(description ? { description: `(${p.in}) ${description}` } : { description: `(${p.in})` }) };
      if (p.required || p.in === "path") required.push(property);
      parameters.push({ property, name: p.name, in: p.in });
    }

    let body: CompiledOperation["body"];
    const requestBody = op.requestBody ? (isRef(op.requestBody) ? (deref(doc, op.requestBody.$ref) as RequestBody) : op.requestBody) : undefined;
    if (requestBody?.content) {
      const contentType =
        Object.keys(requestBody.content).find((ct) => ct.includes("json")) ??
        Object.keys(requestBody.content).find((ct) => ct.includes("x-www-form-urlencoded")) ??
        Object.keys(requestBody.content)[0];
      if (contentType) {
        const schema = inlineRefs(doc, requestBody.content[contentType]?.schema ?? { type: "object" });
        const description = cleanText(requestBody.description, 300);
        properties["body"] = { ...schema, ...(description ? { description: `(request body, ${contentType}) ${description}` } : {}) };
        if (requestBody.required) required.push("body");
        body = { contentType };
      }
    }

    const kind: Kind = op["x-onetool-kind"] ?? (method === "get" || method === "head" ? "read" : "write");
    const summary = cleanText(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`, 160);
    const description = `${method.toUpperCase()} ${path}${op.description ? ` — ${cleanText(op.description, 1500)}` : op.summary ? ` — ${cleanText(op.summary, 300)}` : ""}`;
    return {
      namespace: this.namespace,
      name,
      summary,
      description,
      kind,
      ...(op.tags?.length ? { tags: op.tags } : {}),
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      method,
      path,
      parameters,
      ...(body ? { body } : {}),
    };
  }
}

// ---- helpers ---------------------------------------------------------------------------

function isRef(value: unknown): value is Ref {
  return isPlainObject(value) && typeof value["$ref"] === "string";
}

/** Resolve a local JSON pointer such as `#/components/schemas/Pet`. Remote refs are not supported. */
function deref(doc: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`OpenApiProvider: only local $ref is supported, got "${ref}"`);
  let node: unknown = doc;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainObject(node) || !(key in node)) throw new Error(`OpenApiProvider: unresolvable $ref "${ref}"`);
    node = node[key];
  }
  return node;
}

/** Inline every local $ref so the model receives a self-contained schema. Cycles collapse to a placeholder. */
function inlineRefs(doc: OpenApiDocument, schema: JsonSchema, stack: string[] = []): JsonSchema {
  if (isRef(schema)) {
    const ref = schema.$ref;
    const shortName = ref.split("/").pop() ?? ref;
    if (stack.includes(ref) || stack.length > 12) return { type: "object", description: `${shortName} (recursive; see ${shortName} above)` };
    const target = deref(doc, ref);
    return isPlainObject(target) ? inlineRefs(doc, target, [...stack, ref]) : {};
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isPlainObject(v) ? inlineRefs(doc, v, stack) : v]));
    } else if ((key === "items" || key === "additionalProperties") && isPlainObject(value)) {
      out[key] = inlineRefs(doc, value, stack);
    } else if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      out[key] = value.map((v) => (isPlainObject(v) ? inlineRefs(doc, v, stack) : v));
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function parseBody(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (text.length === 0) return null;
  if (type.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** OpenAPI allows `servers[].url` to be relative to the document's own URL. Resolve it, or explain what is missing. */
function resolveBaseUrl(server: string | undefined, documentUrl: string | undefined): string {
  if (!server) throw new Error("OpenApiProvider: baseUrl is required because the document declares no servers");
  if (/^[a-z][a-z0-9+.-]*:/i.test(server)) return server;
  if (!documentUrl) {
    throw new Error(`OpenApiProvider: servers[0].url "${server}" is relative; pass documentUrl (where the document lives) or baseUrl`);
  }
  return new URL(server, documentUrl).toString();
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "api";
}

/** `get` + `/pets/{petId}` → `get_pets_by_petId`, used only when an operation has no operationId. */
function nameFromPath(method: Method, path: string): string {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? `by_${seg.slice(1, -1)}` : seg.replace(/[^A-Za-z0-9]+/g, "_")));
  return [method, ...parts].join("_");
}
