import { classify } from "./classify.js";
import { normalizeName, Policy, type PolicyConfig } from "./policy.js";
import { DEFAULT_REDACT_KEYS, materialize, redact, shrink, type ResponseOptions } from "./response.js";
import { isPlainObject, validate } from "./schema.js";
import {
  InputValidationError,
  OperationError,
  type CallContext,
  type CallEvent,
  type CallRequest,
  type CallResult,
  type ConfirmFn,
  type Kind,
  type NamespaceInfo,
  type OperationRef,
  type OperationSpec,
  type OperationSummary,
  type Provider,
  type ToolOutcome,
  type ToolSpec,
  type Verdict,
} from "./types.js";

export interface OneToolOptions {
  providers: Provider[];
  policy?: PolicyConfig;
  /** Default consent port. Adapters usually pass their own per call instead. */
  confirm?: ConfirmFn;
  response?: ResponseOptions;
  /** Prefix of the generated tool names: `<prefix>_services`, `_operations`, `_describe`, `_call`. */
  prefix?: string;
  /** One sentence naming what sits behind the tool (shown in tool descriptions). */
  title?: string;
  onEvent?: (event: CallEvent) => void;
}

export interface DescribeResult {
  spec: OperationSpec;
  kind: Kind;
  verdict: Verdict;
  reason: string;
}

export type ListedOperation = OperationSummary & { kind: Kind; verdict: Verdict };

const DEFAULT_RESULT_LIMIT = 32 * 1024;
const DEFAULT_BODY_LIMIT = 64 * 1024;

/**
 * OneTool fronts every operation of its providers with four generic tools.
 * It is the shared half of the design: policy, consent, validation with schema feedback,
 * response redaction and truncation. Providers supply the catalog and the execution.
 */
export class OneTool {
  readonly prefix: string;
  readonly policy: Policy;
  private readonly providers: Provider[];
  private readonly confirmDefault: ConfirmFn | undefined;
  private readonly response: Required<Pick<ResponseOptions, "resultLimit" | "bodyLimit" | "redactKeys">> &
    Pick<ResponseOptions, "redact">;
  private readonly title: string;
  private readonly onEvent: ((event: CallEvent) => void) | undefined;
  private namespaceIndex: Map<string, { info: NamespaceInfo; provider: Provider }> | undefined;

  constructor(options: OneToolOptions) {
    this.providers = options.providers;
    this.policy = new Policy(options.policy);
    this.confirmDefault = options.confirm;
    this.prefix = options.prefix ?? "api";
    this.title = options.title ?? "the configured APIs";
    this.onEvent = options.onEvent;
    this.response = {
      resultLimit: options.response?.resultLimit ?? DEFAULT_RESULT_LIMIT,
      bodyLimit: options.response?.bodyLimit ?? DEFAULT_BODY_LIMIT,
      redactKeys: options.response?.redactKeys ?? [...DEFAULT_REDACT_KEYS],
      ...(options.response?.redact ? { redact: options.response.redact } : {}),
    };
  }

  // ---- catalog -------------------------------------------------------------------------

  async services(query?: string): Promise<NamespaceInfo[]> {
    const index = await this.index();
    const all = [...index.values()].map((e) => e.info);
    return query ? all.filter((n) => matchesQuery(query, n.name, n.summary)) : all;
  }

  async operations(namespace: string | undefined, query?: string): Promise<ListedOperation[]> {
    const { info, provider } = await this.namespace(namespace);
    const list = await provider.operations(info.name);
    const filtered = query ? list.filter((op) => matchesQuery(query, op.name, op.summary, ...(op.tags ?? []))) : list;
    return filtered.map((op) => {
      const ref = { namespace: info.name, name: op.name };
      const kind = this.kindOf(ref, op);
      return { ...op, kind, verdict: this.policy.decide(ref, kind).verdict };
    });
  }

  async describe(namespace: string | undefined, operation: string): Promise<DescribeResult> {
    const { spec, ref } = await this.resolve(namespace, operation);
    const kind = this.kindOf(ref, spec);
    const decision = this.policy.decide(ref, kind);
    return { spec, kind, verdict: decision.verdict, reason: decision.reason };
  }

  // ---- execution -----------------------------------------------------------------------

  async call(request: CallRequest, ctx: CallContext = {}): Promise<CallResult> {
    const started = Date.now();
    const result = await this.callInner(request, ctx);
    if (this.onEvent && result.ref) {
      this.onEvent({
        ref: result.ref,
        kind: result.kind ?? "write",
        verdict: result.verdict ?? "deny",
        result,
        durationMs: Date.now() - started,
      });
    }
    return result;
  }

  private async callInner(request: CallRequest, ctx: CallContext): Promise<CallResult> {
    let resolved: { spec: OperationSpec; ref: OperationRef; provider: Provider };
    try {
      resolved = await this.resolve(request.namespace, request.operation);
    } catch (error) {
      if (error instanceof ResolveError) {
        return { ok: false, stage: "resolve", error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}) };
      }
      throw error;
    }
    const { spec, ref, provider } = resolved;
    const kind = this.kindOf(ref, spec);
    const decision = this.policy.decide(ref, kind);
    const base = { ref, kind, verdict: decision.verdict };
    if (decision.verdict === "deny") {
      return { ok: false, stage: "policy", error: `${ref.namespace}:${ref.name} — ${decision.reason}`, ...base };
    }

    const input = request.input ?? {};
    if (!isPlainObject(input)) {
      return { ok: false, stage: "validate", error: "input must be a JSON object", schema: spec.inputSchema, ...base };
    }
    const problems = validate(spec.inputSchema, input);
    if (problems.length > 0) {
      return { ok: false, stage: "validate", error: problems.join("\n"), schema: spec.inputSchema, ...base };
    }

    if (decision.verdict === "confirm") {
      const confirm = ctx.confirm ?? this.confirmDefault;
      const outcome = confirm
        ? await confirm({ ref, kind, verdictReason: decision.reason, summary: spec.summary, input })
        : "unavailable";
      if (outcome === "declined") {
        return { ok: false, stage: "confirm", error: `${ref.namespace}:${ref.name} was not approved by the user`, ...base };
      }
      if (outcome === "unavailable" && this.policy.onNoConfirm === "deny") {
        return {
          ok: false,
          stage: "confirm",
          error: `${ref.namespace}:${ref.name} requires confirmation (${decision.reason}) but no one can be asked in this session`,
          ...base,
        };
      }
    }

    let raw: unknown;
    try {
      raw = await provider.execute(ref, input, { ...(ctx.signal ? { signal: ctx.signal } : {}), meta: ctx.meta ?? {} });
    } catch (error) {
      if (error instanceof InputValidationError) {
        return { ok: false, stage: "validate", error: error.problems.join("\n"), schema: spec.inputSchema, ...base };
      }
      if (error instanceof OperationError) {
        const details = error.details === undefined ? {} : { details: shrink(error.details, this.response.resultLimit).content };
        return { ok: false, stage: "execute", error: error.message, ...details, ...base };
      }
      return { ok: false, stage: "execute", error: error instanceof Error ? error.message : String(error), ...base };
    }

    const materialized = await materialize(raw, this.response.bodyLimit);
    const keyRedacted = redact(materialized, this.response.redactKeys);
    const safe = this.response.redact ? this.response.redact(keyRedacted) : keyRedacted;
    const { content, truncated } = shrink(safe, this.response.resultLimit);
    return { ok: true, content, truncated, ...base };
  }

  // ---- tool surface --------------------------------------------------------------------

  toolSpecs(): ToolSpec[] {
    const p = this.prefix;
    const namespace = {
      type: "string",
      description: "Namespace (service) of the operation. Omit when only one namespace exists.",
    };
    const operation = { type: "string", description: "Operation name. camelCase, PascalCase and snake_case are all accepted." };
    return [
      {
        name: `${p}_services`,
        description: `List the namespaces (services) reachable through ${this.title}. Use it when unsure which namespace an operation belongs to.`,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Optional substring filter on name or summary." } },
          additionalProperties: false,
        },
        annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      },
      {
        name: `${p}_operations`,
        description: `List operations of a namespace with a one-line summary, their kind (read / write / sensitive) and the policy verdict (allow / confirm / deny). Use the optional query to filter.`,
        inputSchema: {
          type: "object",
          properties: { namespace, query: { type: "string", description: "Optional substring filter on name, summary or tags." } },
          additionalProperties: false,
        },
        annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      },
      {
        name: `${p}_describe`,
        description: `Return the full description and the JSON input schema of one operation. Call it before ${p}_call whenever the parameters are uncertain.`,
        inputSchema: { type: "object", properties: { namespace, operation }, required: ["operation"], additionalProperties: false },
        annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      },
      {
        name: `${p}_call`,
        description: `Execute one operation of ${this.title} with a JSON input. Read operations run directly; write and sensitive operations may ask the user for confirmation or be denied by policy. When the input is invalid, the expected schema is returned instead of a result.`,
        inputSchema: {
          type: "object",
          properties: { namespace, operation, input: { type: "object", description: "Operation input. Get the schema from " + `${p}_describe.` } },
          required: ["operation"],
          additionalProperties: false,
        },
        annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
      },
    ];
  }

  /** Route a tool invocation by name. Adapters register `toolSpecs()` and forward calls here. */
  async handleTool(name: string, args: unknown, ctx: CallContext = {}): Promise<ToolOutcome> {
    const a = isPlainObject(args) ? args : {};
    const str = (key: string): string | undefined => (typeof a[key] === "string" ? (a[key] as string) : undefined);
    const p = this.prefix;
    try {
      switch (name) {
        case `${p}_services`:
          return ok(await this.services(str("query")));
        case `${p}_operations`:
          return ok(await this.operations(str("namespace"), str("query")));
        case `${p}_describe`: {
          const operation = str("operation");
          if (!operation) return fail({ error: "operation is required" });
          const d = await this.describe(str("namespace"), operation);
          return ok({ ...d.spec, kind: d.kind, verdict: d.verdict, reason: d.reason });
        }
        case `${p}_call`: {
          const operation = str("operation");
          if (!operation) return fail({ error: "operation is required" });
          const input = isPlainObject(a["input"]) ? (a["input"] as Record<string, unknown>) : undefined;
          const namespace = str("namespace");
          const result = await this.call(
            { operation, ...(namespace ? { namespace } : {}), ...(input ? { input } : {}) },
            ctx,
          );
          if (result.ok) {
            return { isError: false, content: result.content };
          }
          const { ok: _ok, ...rest } = result;
          return fail(rest);
        }
        default:
          return fail({ error: `unknown tool "${name}"; expected one of ${this.toolSpecs().map((t) => t.name).join(", ")}` });
      }
    } catch (error) {
      if (error instanceof ResolveError) return fail({ error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}) });
      return fail({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---- internals -----------------------------------------------------------------------

  private kindOf(ref: OperationRef, op: Pick<OperationSummary, "name" | "kind">): Kind {
    if (this.policy.isSensitive(ref)) return "sensitive";
    return classify(op);
  }

  private async index(): Promise<Map<string, { info: NamespaceInfo; provider: Provider }>> {
    if (this.namespaceIndex) return this.namespaceIndex;
    const index = new Map<string, { info: NamespaceInfo; provider: Provider }>();
    for (const provider of this.providers) {
      for (const info of await provider.namespaces()) {
        if (index.has(info.name)) throw new Error(`namespace "${info.name}" is provided twice`);
        index.set(info.name, { info, provider });
      }
    }
    this.namespaceIndex = index;
    return index;
  }

  private async namespace(name: string | undefined): Promise<{ info: NamespaceInfo; provider: Provider }> {
    const index = await this.index();
    if (name === undefined) {
      if (index.size === 1) return [...index.values()][0] as { info: NamespaceInfo; provider: Provider };
      throw new ResolveError(`namespace is required; available: ${[...index.keys()].join(", ")}`, [...index.keys()]);
    }
    const exact = index.get(name);
    if (exact) return exact;
    const wanted = normalizeName(name);
    for (const [key, entry] of index) if (normalizeName(key) === wanted) return entry;
    const candidates = [...index.keys()].filter((k) => normalizeName(k).includes(wanted) || wanted.includes(normalizeName(k)));
    throw new ResolveError(`unknown namespace "${name}"; available: ${[...index.keys()].join(", ")}`, candidates);
  }

  private async resolve(namespace: string | undefined, operation: string): Promise<{ spec: OperationSpec; ref: OperationRef; provider: Provider }> {
    const { info, provider } = await this.namespace(namespace);
    const direct = await provider.operation({ namespace: info.name, name: operation });
    if (direct) return { spec: direct, ref: { namespace: info.name, name: direct.name }, provider };
    const wanted = normalizeName(operation);
    const all = await provider.operations(info.name);
    const match = all.find((op) => normalizeName(op.name) === wanted);
    if (match) {
      const spec = await provider.operation({ namespace: info.name, name: match.name });
      if (spec) return { spec, ref: { namespace: info.name, name: spec.name }, provider };
    }
    const candidates = all
      .filter((op) => normalizeName(op.name).includes(wanted) || wanted.includes(normalizeName(op.name)))
      .map((op) => op.name)
      .slice(0, 8);
    throw new ResolveError(
      `unknown operation "${operation}" in namespace "${info.name}"${candidates.length ? `; did you mean: ${candidates.join(", ")}` : `; use ${this.prefix}_operations to list them`}`,
      candidates,
    );
  }
}

class ResolveError extends Error {
  constructor(message: string, readonly candidates?: string[]) {
    super(message);
    this.name = "ResolveError";
  }
}

function matchesQuery(query: string, ...fields: string[]): boolean {
  const q = query.toLowerCase();
  return fields.some((f) => f.toLowerCase().includes(q));
}

function ok(json: unknown): ToolOutcome {
  return { isError: false, content: { json } };
}

function fail(json: unknown): ToolOutcome {
  return { isError: true, content: { json } };
}
