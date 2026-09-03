/** JSON Schema as a plain object. onetool validates a practical subset (type / required / properties / items / enum / additionalProperties). */
export type JsonSchema = Record<string, unknown>;

/** What an operation does to the world. Drives the default policy. */
export type Kind = "read" | "write" | "sensitive";

/** What the policy decided for one call. */
export type Verdict = "allow" | "confirm" | "deny";

export interface NamespaceInfo {
  name: string;
  summary: string;
}

export interface OperationRef {
  namespace: string;
  name: string;
}

export interface OperationSummary extends OperationRef {
  summary: string;
  /** Provider-declared kind. When omitted, onetool infers it from the operation name. */
  kind?: Kind;
  tags?: string[];
}

export interface OperationSpec extends OperationSummary {
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface ExecuteContext {
  signal?: AbortSignal;
  /** Caller-provided metadata (for example the MCP client name). Providers may log it; they must not trust it. */
  meta: Readonly<Record<string, unknown>>;
}

/**
 * A Provider is the pluggable half of onetool: it owns a catalog of operations and knows how to run them.
 * Everything else (policy, consent, validation, redaction, tool surface) is shared.
 */
export interface Provider {
  namespaces(): Promise<NamespaceInfo[]>;
  operations(namespace: string): Promise<OperationSummary[]>;
  operation(ref: OperationRef): Promise<OperationSpec | undefined>;
  execute(ref: OperationRef, input: Record<string, unknown>, ctx: ExecuteContext): Promise<unknown>;
}

/** Throw from Provider.execute when the remote side rejected the input; onetool answers with the expected schema. */
export class InputValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[] | string) {
    const list = typeof problems === "string" ? [problems] : problems;
    super(list.join("; "));
    this.name = "InputValidationError";
    this.problems = list;
  }
}

/** Throw from Provider.execute for a remote failure the model should see verbatim (status, error body, ...). */
export class OperationError extends Error {
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "OperationError";
    this.details = details;
  }
}

export interface ConfirmRequest {
  ref: OperationRef;
  kind: Kind;
  verdictReason: string;
  summary: string;
  input: Record<string, unknown>;
  /** The operation's input schema, so a consent UI can offer the fields for editing. */
  inputSchema: JsonSchema;
}

export type ConfirmOutcome = "approved" | "declined" | "unavailable";

/** Approval may carry an edited input; it is validated again before the call runs. */
export type ConfirmDecision = ConfirmOutcome | { approved: true; input: Record<string, unknown> };

/** The consent port. An adapter decides how a human is asked (MCP elicitation, a terminal prompt, a chat button). */
export type ConfirmFn = (req: ConfirmRequest) => Promise<ConfirmDecision>;

export interface CallContext {
  confirm?: ConfirmFn;
  signal?: AbortSignal;
  meta?: Record<string, unknown>;
}

export interface CallRequest {
  /** Optional when exactly one namespace exists. */
  namespace?: string;
  operation: string;
  input?: Record<string, unknown>;
}

export type Content = { json: unknown } | { text: string };

export type CallStage = "resolve" | "policy" | "confirm" | "validate" | "execute";

export type CallResult =
  | { ok: true; ref: OperationRef; kind: Kind; verdict: Verdict; content: Content; truncated: boolean }
  | {
      ok: false;
      stage: CallStage;
      error: string;
      ref?: OperationRef;
      kind?: Kind;
      verdict?: Verdict;
      /** Present on validation failures so the model can correct itself in the next turn. */
      schema?: JsonSchema;
      candidates?: string[];
      details?: unknown;
    };

/** How operations are presented to the model. See the README's evidence section for the measurements behind `auto`. */
export type Layout = "generic" | "flat" | "auto";

export interface ToolAnnotations {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

/** A tool definition in the shape every function-calling API shares (name / description / JSON Schema). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Shape of the structured result, when it is stable. The generic `call` tool has none: its shape is the operation's. */
  outputSchema?: JsonSchema;
  annotations: ToolAnnotations;
}

export interface ToolOutcome {
  isError: boolean;
  content: Content;
}

export interface CallEvent {
  ref: OperationRef;
  kind: Kind;
  verdict: Verdict;
  result: CallResult;
  durationMs: number;
}
