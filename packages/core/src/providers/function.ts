import type { ExecuteContext, JsonSchema, Kind, NamespaceInfo, OperationRef, OperationSpec, OperationSummary, Provider } from "../types.js";

export interface FunctionOperation<I extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  summary?: string;
  description?: string;
  kind?: Kind;
  tags?: string[];
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  handler: (input: I, ctx: ExecuteContext) => unknown | Promise<unknown>;
}

/**
 * The smallest possible provider: a namespace with hand-written operations.
 * Use it for in-process functions, for tests, and as the template for a real provider.
 */
export class FunctionProvider implements Provider {
  private readonly ops = new Map<string, FunctionOperation>();
  private readonly summary: string;

  constructor(
    readonly namespace: string,
    operations: FunctionOperation[],
    summary?: string,
  ) {
    this.summary = summary ?? `${operations.length} operations`;
    for (const op of operations) {
      if (this.ops.has(op.name)) throw new Error(`operation "${op.name}" is defined twice in namespace "${namespace}"`);
      this.ops.set(op.name, op);
    }
  }

  async namespaces(): Promise<NamespaceInfo[]> {
    return [{ name: this.namespace, summary: this.summary }];
  }

  async operations(namespace: string): Promise<OperationSummary[]> {
    if (namespace !== this.namespace) return [];
    return [...this.ops.values()].map((op) => this.summaryOf(op));
  }

  async operation(ref: OperationRef): Promise<OperationSpec | undefined> {
    if (ref.namespace !== this.namespace) return undefined;
    const op = this.ops.get(ref.name);
    if (!op) return undefined;
    return {
      ...this.summaryOf(op),
      description: op.description ?? op.summary ?? op.name,
      inputSchema: op.inputSchema ?? { type: "object" },
      ...(op.outputSchema ? { outputSchema: op.outputSchema } : {}),
    };
  }

  async execute(ref: OperationRef, input: Record<string, unknown>, ctx: ExecuteContext): Promise<unknown> {
    const op = this.ops.get(ref.name);
    if (!op || ref.namespace !== this.namespace) throw new Error(`unknown operation ${ref.namespace}:${ref.name}`);
    return op.handler(input, ctx);
  }

  private summaryOf(op: FunctionOperation): OperationSummary {
    return {
      namespace: this.namespace,
      name: op.name,
      summary: op.summary ?? op.name,
      ...(op.kind ? { kind: op.kind } : {}),
      ...(op.tags ? { tags: op.tags } : {}),
    };
  }
}
