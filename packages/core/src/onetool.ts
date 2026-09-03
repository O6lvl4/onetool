import { classify } from "./classify.js";
import { Policy, type PolicyConfig } from "./policy.js";
import { buildIndex, matchesQuery, pickNamespace, ResolveError, resolveOperation, type NamespaceEntry, type Resolved } from "./resolve.js";
import { DEFAULT_REDACT_KEYS, materialize, redact, shrink, type ResponseOptions } from "./response.js";
import { isPlainObject, validate } from "./schema.js";
import { flatToolName, flatToolSpec } from "./flat.js";
import { buildToolSpecs, dispatchTool } from "./tools.js";
import {
  InputValidationError,
  OperationError,
  type CallContext,
  type CallEvent,
  type CallRequest,
  type CallResult,
  type ConfirmFn,
  type Kind,
  type Layout,
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
  /** One phrase naming what sits behind the tool, used in tool descriptions. */
  title?: string;
  /**
   * Put a compact index of every operation (namespace, name, one-line summary) into the call tool's
   * description, and tell the model to call directly instead of listing first. On by default: in the
   * measurements in the README it cut turns and tokens at every catalog size. `maxChars` bounds the
   * index (default 4000); pass `false` to leave the call tool's description bare.
   */
  inlineCatalog?: boolean | { maxChars?: number };
  /**
   * `generic` is the four-tool surface, `flat` is one tool per operation behind the same policy,
   * `auto` (default) picks flat while the catalog has at most `autoThreshold` operations.
   */
  layout?: Layout;
  /** Operation count up to which `auto` chooses `flat`. Default 30. */
  autoThreshold?: number;
  onEvent?: (event: CallEvent) => void;
}

export interface ResolvedTools {
  layout: "generic" | "flat";
  specs: ToolSpec[];
}

export interface DescribeResult {
  spec: OperationSpec;
  kind: Kind;
  verdict: Verdict;
  reason: string;
}

export type ListedOperation = OperationSummary & { kind: Kind; verdict: Verdict };

/** A call that passed resolution, policy and validation, ready for consent and execution. */
interface Gated {
  ref: OperationRef;
  kind: Kind;
  verdict: Verdict;
  reason: string;
  spec: OperationSpec;
  provider: Provider;
  input: Record<string, unknown>;
}

type Failure = Extract<CallResult, { ok: false }>;

const DEFAULT_CATALOG_CHARS = 4000;
const DEFAULT_AUTO_THRESHOLD = 30;
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
  private readonly resultLimit: number;
  private readonly bodyLimit: number;
  private readonly redactKeys: readonly string[];
  private readonly redactExtra: ((value: unknown) => unknown) | undefined;
  private readonly title: string;
  private readonly catalogChars: number;
  private readonly layout: Layout;
  private readonly autoThreshold: number;
  private readonly onEvent: ((event: CallEvent) => void) | undefined;
  private index: Map<string, NamespaceEntry> | undefined;
  private flatIndex: Map<string, OperationRef> | undefined;

  constructor(options: OneToolOptions) {
    this.providers = options.providers;
    this.policy = new Policy(options.policy);
    this.confirmDefault = options.confirm;
    this.prefix = options.prefix ?? "api";
    this.title = options.title ?? "the configured APIs";
    this.catalogChars = catalogBudget(options.inlineCatalog);
    this.layout = options.layout ?? "auto";
    this.autoThreshold = options.autoThreshold ?? DEFAULT_AUTO_THRESHOLD;
    this.onEvent = options.onEvent;
    this.resultLimit = options.response?.resultLimit ?? DEFAULT_RESULT_LIMIT;
    this.bodyLimit = options.response?.bodyLimit ?? DEFAULT_BODY_LIMIT;
    this.redactKeys = options.response?.redactKeys ?? DEFAULT_REDACT_KEYS;
    this.redactExtra = options.response?.redact;
  }

  // ---- catalog -------------------------------------------------------------------------

  async services(query?: string): Promise<NamespaceInfo[]> {
    const all = [...(await this.namespaces()).values()].map((e) => e.info);
    return query ? all.filter((n) => matchesQuery(query, n.name, n.summary)) : all;
  }

  async operations(namespace: string | undefined, query?: string): Promise<ListedOperation[]> {
    const { info, provider } = pickNamespace(await this.namespaces(), namespace);
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
    const { verdict, reason } = this.policy.decide(ref, kind);
    return { spec, kind, verdict, reason };
  }

  // ---- execution -----------------------------------------------------------------------

  async call(request: CallRequest, ctx: CallContext = {}): Promise<CallResult> {
    const started = Date.now();
    const result = await this.runPipeline(request, ctx);
    if (this.onEvent && result.ref) {
      this.onEvent({ ref: result.ref, kind: result.kind ?? "write", verdict: result.verdict ?? "deny", result, durationMs: Date.now() - started });
    }
    return result;
  }

  private async runPipeline(request: CallRequest, ctx: CallContext): Promise<CallResult> {
    let resolved: Resolved;
    try {
      resolved = await this.resolve(request.namespace, request.operation);
    } catch (error) {
      if (error instanceof ResolveError) return { ok: false, stage: "resolve", error: error.message, candidates: error.candidates };
      throw error;
    }
    const gated = this.gate(resolved, request.input ?? {});
    if ("ok" in gated) return gated;
    const consented = await this.consent(gated, ctx);
    if ("ok" in consented) return consented;
    return this.execute(consented, ctx);
  }

  /** Policy decision and input validation. Nothing here touches the provider. */
  private gate(resolved: Resolved, input: unknown): Gated | Failure {
    const { spec, ref, provider } = resolved;
    const kind = this.kindOf(ref, spec);
    const { verdict, reason } = this.policy.decide(ref, kind);
    const base = { ref, kind, verdict };
    if (verdict === "deny") return { ok: false, stage: "policy", error: `${ref.namespace}:${ref.name} — ${reason}`, ...base };
    if (!isPlainObject(input)) return { ok: false, stage: "validate", error: "input must be a JSON object", schema: spec.inputSchema, ...base };
    const problems = validate(spec.inputSchema, input);
    if (problems.length > 0) return { ok: false, stage: "validate", error: problems.join("\n"), schema: spec.inputSchema, ...base };
    return { ...base, reason, spec, provider, input };
  }

  /**
   * Ask the consent port when the verdict is `confirm`. The human may approve as is, approve with an
   * edited input (validated again here), decline, or be unreachable, in which case `onNoConfirm` decides.
   */
  private async consent(gated: Gated, ctx: CallContext): Promise<Gated | Failure> {
    if (gated.verdict !== "confirm") return gated;
    const { ref, kind, verdict, reason, spec, input } = gated;
    const confirm = ctx.confirm ?? this.confirmDefault;
    const decision = confirm ? await confirm({ ref, kind, verdictReason: reason, summary: spec.summary, input, inputSchema: spec.inputSchema }) : "unavailable";
    if (decision === "approved") return gated;
    if (typeof decision === "object") {
      const problems = validate(spec.inputSchema, decision.input);
      if (problems.length > 0) {
        return { ok: false, stage: "validate", error: `edited input rejected:\n${problems.join("\n")}`, schema: spec.inputSchema, ref, kind, verdict };
      }
      return { ...gated, input: decision.input };
    }
    if (decision === "unavailable" && this.policy.onNoConfirm === "allow") return gated;
    const error =
      decision === "declined"
        ? `${ref.namespace}:${ref.name} was not approved by the user`
        : `${ref.namespace}:${ref.name} requires confirmation (${reason}) but no one can be asked in this session`;
    return { ok: false, stage: "confirm", error, ref, kind, verdict };
  }

  private async execute(gated: Gated, ctx: CallContext): Promise<CallResult> {
    const { ref, kind, verdict, provider, input } = gated;
    let raw: unknown;
    try {
      raw = await provider.execute(ref, input, { ...(ctx.signal ? { signal: ctx.signal } : {}), meta: ctx.meta ?? {} });
    } catch (error) {
      return this.failureFrom(error, gated);
    }
    const materialized = await materialize(raw, this.bodyLimit);
    const keyRedacted = redact(materialized, this.redactKeys);
    const safe = this.redactExtra ? this.redactExtra(keyRedacted) : keyRedacted;
    const { content, truncated } = shrink(safe, this.resultLimit);
    return { ok: true, ref, kind, verdict, content, truncated };
  }

  private failureFrom(error: unknown, gated: Gated): Failure {
    const base = { ref: gated.ref, kind: gated.kind, verdict: gated.verdict };
    if (error instanceof InputValidationError) {
      return { ok: false, stage: "validate", error: error.problems.join("\n"), schema: gated.spec.inputSchema, ...base };
    }
    if (error instanceof OperationError) {
      const details = error.details === undefined ? {} : { details: shrink(error.details, this.resultLimit).content };
      return { ok: false, stage: "execute", error: error.message, ...details, ...base };
    }
    return { ok: false, stage: "execute", error: error instanceof Error ? error.message : String(error), ...base };
  }

  // ---- tool surface --------------------------------------------------------------------

  /** The generic four-tool surface without the catalog. Synchronous; adapters that can wait should call `tools()`. */
  toolSpecs(): ToolSpec[] {
    return buildToolSpecs(this.prefix, this.title);
  }

  /** The tools to register, in the configured layout, with the inline catalog when it applies. */
  async tools(): Promise<ResolvedTools> {
    const layout = await this.effectiveLayout();
    if (layout === "flat") return { layout, specs: await this.flatSpecs() };
    return { layout, specs: await this.genericSpecs() };
  }

  private async effectiveLayout(): Promise<"generic" | "flat"> {
    if (this.layout !== "auto") return this.layout;
    let count = 0;
    for (const ns of await this.services()) count += (await this.operations(ns.name)).length;
    return count <= this.autoThreshold ? "flat" : "generic";
  }

  private async genericSpecs(): Promise<ToolSpec[]> {
    const specs = this.toolSpecs();
    if (this.catalogChars <= 0) return specs;
    const catalog = await this.catalogText(this.catalogChars);
    return specs.map((spec) => (spec.name === `${this.prefix}_call` ? { ...spec, description: withCatalog(spec.description, catalog) } : spec));
  }

  private async flatSpecs(): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    for (const [name, ref] of await this.flatNames()) {
      const { spec, kind } = await this.describe(ref.namespace, ref.name);
      specs.push(flatToolSpec(name, { ...spec, kind }));
    }
    return specs;
  }

  /** Flat tool name → operation. Built once; a clash after sanitising gets a numeric suffix. */
  private async flatNames(): Promise<Map<string, OperationRef>> {
    if (this.flatIndex) return this.flatIndex;
    const index = new Map<string, OperationRef>();
    for (const ns of await this.services()) {
      for (const op of await this.operations(ns.name)) {
        const ref = { namespace: ns.name, name: op.name };
        let name = flatToolName(ref);
        for (let n = 2; index.has(name); n++) name = `${flatToolName(ref).slice(0, 60)}_${n}`;
        index.set(name, ref);
      }
    }
    this.flatIndex = index;
    return index;
  }

  /** One line per namespace: `namespace: op — summary; op — summary`, cut at `maxChars` with a pointer to the list tool. */
  async catalogText(maxChars: number): Promise<string> {
    const lines: string[] = [];
    let omitted = 0;
    let used = 0;
    for (const ns of await this.services()) {
      const entries = (await this.operations(ns.name)).map((op) => `${op.name} — ${op.summary}`);
      const line = `${ns.name}: ${entries.join("; ")}`;
      if (used + line.length + 1 > maxChars) {
        omitted += entries.length;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (omitted > 0) lines.push(`(${omitted} more operations; use ${this.prefix}_operations to list them)`);
    return lines.join("\n");
  }

  /** Route a tool invocation by name, generic or flat. Adapters register `tools()` and forward calls here. */
  async handleTool(name: string, args: unknown, ctx: CallContext = {}): Promise<ToolOutcome> {
    if (name.startsWith(`${this.prefix}_`)) return dispatchTool(this, name, args, ctx);
    const ref = (await this.flatNames()).get(name);
    if (!ref) return dispatchTool(this, name, args, ctx);
    const input = isPlainObject(args) ? args : {};
    const result = await this.call({ namespace: ref.namespace, operation: ref.name, input }, ctx);
    return result.ok ? { isError: false, content: result.content } : { isError: true, content: { json: result } };
  }

  // ---- internals -----------------------------------------------------------------------

  private kindOf(ref: OperationRef, op: Pick<OperationSummary, "name" | "kind">): Kind {
    return this.policy.isSensitive(ref) ? "sensitive" : classify(op);
  }

  private async namespaces(): Promise<Map<string, NamespaceEntry>> {
    this.index ??= await buildIndex(this.providers);
    return this.index;
  }

  private async resolve(namespace: string | undefined, operation: string): Promise<Resolved> {
    return resolveOperation(pickNamespace(await this.namespaces(), namespace), operation, `${this.prefix}_operations`);
  }
}

function catalogBudget(option: OneToolOptions["inlineCatalog"]): number {
  if (option === false) return 0;
  if (option === true || option === undefined) return DEFAULT_CATALOG_CHARS;
  return option.maxChars ?? DEFAULT_CATALOG_CHARS;
}

function withCatalog(description: string, catalog: string): string {
  return `${description} Call directly when you know the operation: an unknown name returns candidates and invalid input returns the schema, so calling first is usually faster than listing or describing.\nOperations (namespace: name — summary):\n${catalog}`;
}
