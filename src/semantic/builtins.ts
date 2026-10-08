import { typeName } from "./types.js";
/**
 * Mynt built-ins: platform functions the language understands natively.
 *
 * A built-in is resolved by the binder from ordinary identifiers (`log.debug`
 * is a MemberExpression over the identifier `log`; `load` is a root
 * identifier), never by the lexer or parser. Each built-in declares the
 * NetSuite module it needs, which is how the compiler infers `define([...])`
 * dependencies without explicit imports.
 *
 * Built-ins live either at the root scope (`load`) or inside a namespace
 * (`log.debug`, a future `email.send`). Adding one means adding an entry here
 * plus a lowering in the backend; the parser is untouched.
 */
import type { FieldType } from "../schema/types.js";
import type { MyntType } from "./types.js";

/** SuiteScript modules the compiler knows how to depend on. */
export type NetSuiteModule = "N/log" | "N/record" | "N/query" | "N/search";

/**
 * What a built-in parameter accepts. `RecordId` is an internal id, which
 * NetSuite takes as a string or a number: `load Customer(123)` and
 * `load Customer("123")` are both valid. It is not a Mynt type and there is
 * no union syntax; the binder simply accepts either primitive here.
 */
export type BuiltinParameter = FieldType | "RecordId";

/** Whether a value of `actual` may be passed where `expected` is declared. */
export function acceptsArgument(expected: BuiltinParameter, actual: MyntType): boolean {
  if (expected === "RecordId") return actual === "Text" || actual === "Number";
  return actual === expected;
}

/** The spelling of a parameter in signatures and diagnostics: `string`, or `string | number` for a record id. */
export function parameterTypeName(parameter: BuiltinParameter): string {
  return parameter === "RecordId" ? "string | number" : typeName(parameter);
}

export type BuiltinId = "log.debug" | "log.audit" | "log.error" | "log.emergency" | "load" | "create" | "copy" | "transform";

interface BuiltinBase {
  id: BuiltinId;
  /** Display name in diagnostics, e.g. `log.debug`. */
  name: string;
  /** Module whose presence in `define([...])` this built-in requires, if any. */
  module: NetSuiteModule | undefined;
  /** Types of the ordinary (parenthesised) arguments. */
  parameters: readonly BuiltinParameter[];
  /** Names for the parameters, for signatures shown in editors. Same length as `parameters`. */
  parameterNames: readonly string[];
  /** One sentence for editors. */
  summary: string;
}

/** A built-in over values only: `log.debug("x")`. */
export interface PlainBuiltin extends BuiltinBase {
  kind: "function";
  returns: FieldType | "Void";
}

/**
 * A record operation: a built-in written with a record type, `load T(...)`,
 * `create T`, `transform T(...) to U`. Everything the binder, the lifecycle
 * analysis, and the emitter need to know about it is declared here, so
 * adding one is an entry plus a lowering, never a new branch elsewhere.
 */
export interface RecordOperation extends BuiltinBase {
  kind: "recordOperation";
  /** Whether a target record type follows the arguments: `T(...) to U`. */
  target: boolean;
  /** Which written record type the result has. The result is always an owned record. */
  returns: "subject" | "target";
  /** Whether the result already exists in NetSuite, or exists only once saved. */
  result: "existing" | "new";
}

export type Builtin = PlainBuiltin | RecordOperation;

export interface BuiltinNamespace {
  name: string;
  /** Noun used in diagnostics: "'info' is not a supported log method". */
  memberNoun: string;
  members: ReadonlyMap<string, Builtin>;
}

function logMethod(level: "debug" | "audit" | "error" | "emergency"): Builtin {
  return {
    id: `log.${level}`,
    name: `log.${level}`,
    module: "N/log",
    kind: "function",
    parameters: ["Text"],
    parameterNames: ["message"],
    summary: `Writes a ${level} entry to the NetSuite execution log.`,
    returns: "Void",
  };
}

/** N/log exposes exactly these four levels; there is no `info`. */
const LOG_NAMESPACE: BuiltinNamespace = {
  name: "log",
  memberNoun: "log method",
  members: new Map(
    (["debug", "audit", "error", "emergency"] as const).map((level) => [level, logMethod(level)]),
  ),
};

/** `load Customer("123")`: N/record `record.load`, returning the named record type. */
const LOAD: Builtin = {
  id: "load",
  name: "load",
  module: "N/record",
  kind: "recordOperation",
  target: false,
  parameters: ["RecordId"],
  parameterNames: ["id"],
  summary: "Loads the existing record with the given internal id.",
  returns: "subject",
  result: "existing",
};

/** `create Customer`: N/record `record.create`. The record exists in NetSuite only after `save`. */
const CREATE: Builtin = {
  id: "create",
  name: "create",
  module: "N/record",
  kind: "recordOperation",
  target: false,
  parameters: [],
  parameterNames: [],
  summary: "Creates a new, unsaved record of type T.",
  returns: "subject",
  result: "new",
};

/** `copy Customer("123")`: N/record `record.copy`. A new, unsaved copy of an existing record. */
const COPY: Builtin = {
  id: "copy",
  name: "copy",
  module: "N/record",
  kind: "recordOperation",
  target: false,
  parameters: ["RecordId"],
  parameterNames: ["id"],
  summary: "Creates a new, unsaved copy of the record with the given internal id.",
  returns: "subject",
  result: "new",
};

/**
 * `transform SalesOrder("123") to Invoice`: N/record `record.transform`. A
 * new, unsaved record of the target type derived from the source. NetSuite
 * permits only certain source/target pairs; Mynt does not check the pair,
 * so an unsupported one fails at runtime.
 */
const TRANSFORM: Builtin = {
  id: "transform",
  name: "transform",
  module: "N/record",
  kind: "recordOperation",
  target: true,
  parameters: ["RecordId"],
  parameterNames: ["id"],
  summary: "Creates a new, unsaved record of type U from the existing record of type T with the given internal id.",
  returns: "target",
  result: "new",
};

const NAMESPACES: ReadonlyMap<string, BuiltinNamespace> = new Map([[LOG_NAMESPACE.name, LOG_NAMESPACE]]);

const ROOT_BUILTINS: ReadonlyMap<string, Builtin> = new Map([
  [LOAD.name, LOAD],
  [CREATE.name, CREATE],
  [COPY.name, COPY],
  [TRANSFORM.name, TRANSFORM],
]);

export type BuiltinSymbol = { kind: "namespace"; namespace: BuiltinNamespace } | { kind: "builtin"; builtin: Builtin };

/** Resolves a root identifier to a built-in symbol, if it names one. */
export function resolveBuiltinRoot(name: string): BuiltinSymbol | undefined {
  const namespace = NAMESPACES.get(name);
  if (namespace) return { kind: "namespace", namespace };
  const builtin = ROOT_BUILTINS.get(name);
  if (builtin) return { kind: "builtin", builtin };
  return undefined;
}

/** `load T(id: string | number): T`, `create T: T`, `transform T(id: string | number) to U: U`, `log.debug(message: string): Void`. `:` reads "has type", as in parameters and user functions. */
export function builtinSignature(builtin: Builtin): string {
  const params = builtin.parameters.map((type, i) => `${builtin.parameterNames[i] ?? `arg${i + 1}`}: ${parameterTypeName(type)}`).join(", ");
  if (builtin.kind === "function") return `${builtin.name}(${params}): ${builtin.returns}`;
  const list = builtin.parameters.length === 0 ? "" : `(${params})`;
  const target = builtin.target ? " to U" : "";
  return `${builtin.name} T${list}${target}: ${builtin.returns === "subject" ? "T" : "U"}`;
}

/** Every root name and every namespace member, for completion. */
export function listBuiltinRoots(): BuiltinSymbol[] {
  return [
    ...[...NAMESPACES.values()].map((namespace): BuiltinSymbol => ({ kind: "namespace", namespace })),
    ...[...ROOT_BUILTINS.values()].map((builtin): BuiltinSymbol => ({ kind: "builtin", builtin })),
  ];
}

/** Names visible at root scope, for "unknown identifier" diagnostics. */
export function builtinRootNames(): string[] {
  return [...NAMESPACES.keys(), ...ROOT_BUILTINS.keys()].sort();
}
