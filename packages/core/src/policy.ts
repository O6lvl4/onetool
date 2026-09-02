import type { Kind, OperationRef, Verdict } from "./types.js";

/**
 * Policy configuration. Patterns are `namespace:operation` with `*` wildcards, matched
 * case-insensitively and ignoring `-` and `_` (so `pet-store:list_pets` equals `petstore:listPets`).
 *
 * Precedence: deny → allow → confirm → sensitive (confirm) → mode default.
 *   guided (default): read → allow, write → confirm.
 *   strict:           anything not explicitly allowed → deny.
 */
export interface PolicyConfig {
  mode?: "guided" | "strict";
  allow?: string[];
  confirm?: string[];
  deny?: string[];
  /** Operations that disclose secrets. They require confirmation even when they only read. */
  sensitive?: string[];
  /** What to do when a confirmation is required but no one can answer (headless, client without elicitation). */
  onNoConfirm?: "deny" | "allow";
}

export interface Decision {
  verdict: Verdict;
  reason: string;
}

interface CompiledPattern {
  source: string;
  namespace: RegExp;
  operation: RegExp;
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

function compile(pattern: string): CompiledPattern {
  const colon = pattern.indexOf(":");
  const [ns, op] = colon < 0 ? ["*", pattern] : [pattern.slice(0, colon), pattern.slice(colon + 1)];
  const toRegExp = (glob: string): RegExp =>
    new RegExp(`^${normalizeName(glob).split("*").map(escape).join(".*")}$`, "i");
  return { source: pattern, namespace: toRegExp(ns || "*"), operation: toRegExp(op || "*") };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Policy {
  readonly mode: "guided" | "strict";
  readonly onNoConfirm: "deny" | "allow";
  private readonly allow: CompiledPattern[];
  private readonly confirm: CompiledPattern[];
  private readonly deny: CompiledPattern[];
  private readonly sensitive: CompiledPattern[];

  constructor(config: PolicyConfig = {}) {
    this.mode = config.mode ?? "guided";
    this.onNoConfirm = config.onNoConfirm ?? "deny";
    this.allow = (config.allow ?? []).map(compile);
    this.confirm = (config.confirm ?? []).map(compile);
    this.deny = (config.deny ?? []).map(compile);
    this.sensitive = (config.sensitive ?? []).map(compile);
  }

  isSensitive(ref: OperationRef): boolean {
    return this.match(this.sensitive, ref) !== undefined;
  }

  decide(ref: OperationRef, kind: Kind): Decision {
    const denied = this.match(this.deny, ref);
    if (denied) return { verdict: "deny", reason: `denied by policy pattern "${denied.source}"` };
    const allowed = this.match(this.allow, ref);
    if (allowed) return { verdict: "allow", reason: `allowed by policy pattern "${allowed.source}"` };
    const confirmed = this.match(this.confirm, ref);
    if (confirmed) return { verdict: "confirm", reason: `confirmation required by policy pattern "${confirmed.source}"` };
    if (kind === "sensitive") return { verdict: "confirm", reason: "operation may disclose secrets" };
    if (this.mode === "strict") return { verdict: "deny", reason: "strict mode: operation is not in the allow list" };
    if (kind === "read") return { verdict: "allow", reason: "read operation (guided mode)" };
    return { verdict: "confirm", reason: "write operation (guided mode)" };
  }

  private match(patterns: CompiledPattern[], ref: OperationRef): CompiledPattern | undefined {
    const ns = normalizeName(ref.namespace);
    const op = normalizeName(ref.name);
    return patterns.find((p) => p.namespace.test(ns) && p.operation.test(op));
  }
}
