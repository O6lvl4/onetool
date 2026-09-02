import { cleanText, type ExecuteContext, type NamespaceInfo, type OperationRef, type OperationSpec, type OperationSummary, type Provider } from "@o6lvl4/onetool-core";
import { compileDocument, type CompiledOperation } from "./compile.js";
import { interpretResponse, prepareRequest } from "./request.js";
import type { OpenApiDocument } from "./types.js";

export type { OpenApiDocument } from "./types.js";
export { nameFromPath } from "./compile.js";

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

  constructor(options: OpenApiProviderOptions) {
    const doc = options.document;
    this.namespace = options.namespace ?? slug(doc.info?.title ?? "api");
    this.baseUrl = resolveBaseUrl(options.baseUrl ?? doc.servers?.[0]?.url, options.documentUrl).replace(/\/+$/, "");
    this.headers = options.headers;
    this.fetchFn = options.fetch ?? fetch;
    this.ops = compileDocument(doc, { namespace: this.namespace, includeDeprecated: options.includeDeprecated ?? false });
    this.summary = options.summary ?? (cleanText(doc.info?.description, 200) || `${doc.info?.title ?? "API"} (${this.ops.size} operations)`);
  }

  async namespaces(): Promise<NamespaceInfo[]> {
    return [{ name: this.namespace, summary: this.summary }];
  }

  async operations(namespace: string): Promise<OperationSummary[]> {
    if (namespace !== this.namespace) return [];
    return [...this.ops.values()].map(({ spec }) => summaryOf(spec));
  }

  async operation(ref: OperationRef): Promise<OperationSpec | undefined> {
    return ref.namespace === this.namespace ? this.ops.get(ref.name)?.spec : undefined;
  }

  async execute(ref: OperationRef, input: Record<string, unknown>, ctx: ExecuteContext): Promise<unknown> {
    const op = this.ops.get(ref.name);
    if (!op || ref.namespace !== this.namespace) throw new Error(`unknown operation ${ref.namespace}:${ref.name}`);
    const configured = typeof this.headers === "function" ? await this.headers() : (this.headers ?? {});
    const { url, init } = prepareRequest({ baseUrl: this.baseUrl, op, input, headers: configured, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    return interpretResponse(op, await this.fetchFn(url, init));
  }
}

function summaryOf(spec: OperationSpec): OperationSummary {
  const { namespace, name, summary, kind, tags } = spec;
  return { namespace, name, summary, ...(kind ? { kind } : {}), ...(tags ? { tags } : {}) };
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
