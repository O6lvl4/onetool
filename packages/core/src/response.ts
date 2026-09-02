import { isPlainObject } from "./schema.js";
import type { Content } from "./types.js";

export interface ResponseOptions {
  /** Maximum serialized size (characters) returned to the model. Larger results are cut and flagged. */
  resultLimit?: number;
  /** Maximum bytes read from a stream or byte array found in a result. */
  bodyLimit?: number;
  /** Keys whose values are replaced with "**REDACTED**" (case-insensitive, exact key names). */
  redactKeys?: string[];
  /** Extra redaction after the key-based pass, for shapes a key list cannot express. */
  redact?: (value: unknown) => unknown;
}

/**
 * Key names known to carry secrets. Exact names only: a generic "token" would also hide pagination tokens.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  "secretaccesskey", "sessiontoken", "secretstring", "secretbinary", "authorizationtoken", "password",
  "accesstoken", "refreshtoken", "idtoken", "apikey", "clientsecret", "keymaterial", "privatekey",
  "sharedsecret", "dbpassword", "masteruserpassword", "plaintext", "privatekeyplaintext",
  "authorization", "secret", "passphrase",
];

const REDACTED = "**REDACTED**";

export function redact(value: unknown, keys: readonly string[] = DEFAULT_REDACT_KEYS): unknown {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, member] of Object.entries(v)) out[k] = set.has(k.toLowerCase()) ? REDACTED : walk(member);
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * Turn streams and byte arrays into strings the model can read, bounded by `bodyLimit`.
 * Anything else is returned as is. Only the top level and one level of nesting are inspected,
 * which is where HTTP bodies and SDK payloads live.
 */
export async function materialize(value: unknown, bodyLimit: number): Promise<unknown> {
  const one = async (v: unknown): Promise<unknown> => {
    if (v instanceof Uint8Array) return bytesToText(v, bodyLimit);
    if (isAsyncIterable(v)) return streamToText(v, bodyLimit);
    if (isReadableStream(v)) return streamToText(readableToIterable(v), bodyLimit);
    return v;
  };
  const top = await one(value);
  if (top !== value) return top;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, member] of Object.entries(value)) out[k] = await one(member);
    return out;
  }
  return value;
}

function bytesToText(bytes: Uint8Array, limit: number): string {
  if (bytes.byteLength > limit) return `<${bytes.byteLength} bytes; omitted (limit ${limit})>`;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return `<binary, ${bytes.byteLength} bytes>`;
  }
}

async function streamToText(stream: AsyncIterable<unknown>, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size > limit) return `<stream exceeds ${limit} bytes; omitted>`;
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return bytesToText(joined, limit);
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return v !== null && typeof v === "object" && Symbol.asyncIterator in v && !(v instanceof Uint8Array);
}

function isReadableStream(v: unknown): v is ReadableStream<Uint8Array> {
  return v !== null && typeof v === "object" && typeof (v as ReadableStream).getReader === "function";
}

async function* readableToIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Serialize for the model. Over the limit, cut the text and say so, so the model narrows the query instead of retrying blindly. */
export function shrink(value: unknown, resultLimit: number): { content: Content; truncated: boolean } {
  const text = JSON.stringify(value, replacer);
  if (text === undefined) return { content: { text: "" }, truncated: false };
  if (text.length <= resultLimit) return { content: { json: value }, truncated: false };
  return {
    content: {
      text: `${text.slice(0, resultLimit)}\n…[truncated: ${text.length} characters; narrow the request (filters, page size) to see the rest]`,
    },
    truncated: true,
  };
}

function replacer(_key: string, v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Map) return Object.fromEntries(v);
  if (v instanceof Set) return [...v];
  return v;
}
