import { cleanText } from "./schema.js";
import type { OperationRef, OperationSpec, ToolSpec } from "./types.js";

/** Tool names must satisfy `^[A-Za-z0-9_-]{1,64}$` on every major function-calling API. */
export function flatToolName(ref: OperationRef): string {
  const raw = `${ref.namespace}__${ref.name}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return raw.length <= 64 ? raw : raw.slice(0, 64);
}

/** One tool per operation, with the operation's own schemas and a kind-derived annotation set. */
export function flatToolSpec(name: string, spec: OperationSpec): ToolSpec {
  const summary = cleanText(spec.summary, 200);
  const description = spec.description && spec.description !== spec.summary ? `${summary}. ${cleanText(spec.description, 800)}` : summary;
  const read = spec.kind === "read";
  return {
    name,
    description,
    inputSchema: spec.inputSchema,
    ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
    annotations: { readOnly: read, destructive: !read, idempotent: read, openWorld: true },
  };
}
