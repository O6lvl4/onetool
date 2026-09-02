import { InputValidationError, OperationError } from "@o6lvl4/onetool-core";
import type { BoundParameter, CompiledOperation } from "./compile.js";

export interface PreparedRequest {
  url: string;
  init: RequestInit;
}

export interface RequestParts {
  baseUrl: string;
  op: CompiledOperation;
  input: Record<string, unknown>;
  /** Headers configured on the provider (for example Authorization). They override parameter headers. */
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** Where each bound parameter lands while the request is being assembled. */
interface Sink {
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

/** Turn the flat input object back into URL, query string, headers and body. */
export function prepareRequest({ baseUrl, op, input, headers, signal }: RequestParts): PreparedRequest {
  const sink: Sink = { path: op.path, query: new URLSearchParams(), headers: { accept: "application/json, text/*;q=0.8, */*;q=0.5" } };
  for (const p of op.parameters) {
    const value = input[p.property];
    if (value !== undefined && value !== null) place(p, value, sink);
  }
  Object.assign(sink.headers, headers);
  const body = encodeBody(op, input["body"]);
  if (body !== undefined && op.body) sink.headers["content-type"] = op.body.contentType;
  const qs = sink.query.toString();
  return {
    url: `${baseUrl}${sink.path}${qs ? `?${qs}` : ""}`,
    init: { method: op.method.toUpperCase(), headers: sink.headers, ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) },
  };
}

function place(p: BoundParameter, value: unknown, sink: Sink): void {
  switch (p.in) {
    case "path":
      sink.path = sink.path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
      return;
    case "query":
      for (const v of Array.isArray(value) ? value : [value]) sink.query.append(p.name, scalar(v));
      return;
    case "header":
      sink.headers[p.name] = String(value);
      return;
    case "cookie": {
      const existing = sink.headers["cookie"];
      sink.headers["cookie"] = `${existing ? `${existing}; ` : ""}${p.name}=${encodeURIComponent(String(value))}`;
      return;
    }
  }
}

function scalar(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

function encodeBody(op: CompiledOperation, body: unknown): string | undefined {
  if (!op.body || body === undefined) return undefined;
  if (!op.body.contentType.includes("x-www-form-urlencoded")) return JSON.stringify(body);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) form.append(k, String(v));
  return form.toString();
}

/** Parse the body, then map the status: 400/422 are the model's fault, other failures are the remote's. */
export async function interpretResponse(op: CompiledOperation, response: Response): Promise<{ status: number; body: unknown }> {
  const body = await parseBody(response);
  const where = `${op.method.toUpperCase()} ${op.path}`;
  if (response.status === 400 || response.status === 422) {
    throw new InputValidationError([`HTTP ${response.status} from ${where}: ${typeof body === "string" ? body : JSON.stringify(body)}`]);
  }
  if (!response.ok) throw new OperationError(`HTTP ${response.status} ${response.statusText} from ${where}`, body);
  return { status: response.status, body };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  if (!(response.headers.get("content-type") ?? "").includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
