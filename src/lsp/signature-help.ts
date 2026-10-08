/**
 * Signature help: which call the cursor is inside, and which argument.
 *
 * The call is found on the token stream, since the code is usually
 * incomplete exactly here: scanning back from the cursor, skipping balanced
 * parentheses, the first unmatched `(` opens the call, and the commas at
 * that depth count the active argument. The callee is the name before that
 * `(`: a function, a built-in, a namespace member, or a record operation
 * with its written type. What that name means is asked of the semantic
 * document, never guessed from spelling, and the signature text is the one
 * hover shows, specialized to the written record type when there is one.
 */
import { DiagnosticBag } from "../diagnostics.js";
import { tokenize } from "../lexer/lexer.js";
import type { Token } from "../lexer/tokens.js";
import type { BoundFunction } from "../semantic/bound.js";
import { parameterTypeName, type Builtin } from "../semantic/builtins.js";
import type { RecordSchema } from "../schema/types.js";
import { resolveNameAt, type SemanticDocument } from "../semantic/query.js";
import { typeName } from "../semantic/types.js";

export interface SignatureParameter {
  name: string;
  type: string;
}

/** A signature as text plus where each parameter sits in it. */
export interface Signature {
  label: string;
  parameters: { label: string; start: number; end: number }[];
  documentation?: string;
}

export interface SignatureHelpResult {
  signature: Signature;
  activeParameter: number;
}

/** `prefix(a: T, b: U)suffix` with the character range of each parameter. */
export function buildSignature(prefix: string, parameters: SignatureParameter[], suffix: string, documentation?: string): Signature {
  let label = `${prefix}(`;
  const ranges: Signature["parameters"] = [];
  parameters.forEach((parameter, index) => {
    if (index > 0) label += ", ";
    const text = `${parameter.name}: ${parameter.type}`;
    ranges.push({ label: text, start: label.length, end: label.length + text.length });
    label += text;
  });
  label += `)${suffix}`;
  return documentation ? { label, parameters: ranges, documentation } : { label, parameters: ranges };
}

export function functionSignatureInfo(fn: BoundFunction): Signature {
  return buildSignature(
    `fn ${fn.name}`,
    fn.parameters.map((p) => ({ name: p.name, type: typeName(p.type) })),
    fn.returnType === "Void" ? "" : `: ${typeName(fn.returnType)}`,
  );
}

/** A built-in's signature; `subject` is the record type written before the arguments, when known. */
export function builtinSignatureInfo(builtin: Builtin, subject?: string): Signature {
  const parameters = builtin.parameters.map((type, i) => ({ name: builtin.parameterNames[i] ?? `arg${i + 1}`, type: parameterTypeName(type) }));
  if (builtin.kind === "function") return buildSignature(builtin.name, parameters, `: ${builtin.returns}`, builtin.summary);
  const t = subject ?? "T";
  const target = builtin.target ? " to U" : "";
  const result = builtin.returns === "subject" ? t : "U";
  return buildSignature(`${builtin.name} ${t}`, parameters, `${target}: ${result}`, builtin.summary);
}

/** `Customer(id: string | number): Ref<Customer>`: the record reference constructor. */
export function referenceSignatureInfo(record: RecordSchema): Signature {
  return buildSignature(
    record.name,
    [{ name: "id", type: parameterTypeName("RecordId") }],
    `: Ref<${record.name}>`,
    `A typed reference to the ${record.name} with this internal id. Nothing is loaded; read fields with [email, ...] or load ${record.name}(ref.id).`,
  );
}

export function signatureHelpAt(doc: SemanticDocument, offset: number): SignatureHelpResult | undefined {
  const all = tokenize(doc.text, new DiagnosticBag(""));
  if (all.some((t) => t.kind === "String" && t.span.start.offset < offset && offset < t.span.end.offset)) return undefined;
  const tokens = all.filter((t) => t.kind !== "EOF" && t.span.end.offset <= offset);

  // The innermost unmatched '(' before the cursor, and the commas at its depth.
  let depth = 0;
  let open = -1;
  let commas = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.kind === "RParen") depth++;
    else if (t.kind === "LParen") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    } else if (t.kind === "Comma" && depth === 0) commas++;
    else if ((t.kind === "LBrace" || t.kind === "RBrace" || t.kind === "Terminator") && depth === 0) return undefined;
  }
  if (open < 0) return undefined;

  const callee = calleeBefore(tokens, open);
  if (!callee) return undefined;
  const signature = resolveSignature(doc, callee, tokens[open]!.span.start.offset);
  return signature ? { signature, activeParameter: commas } : undefined;
}

interface Callee {
  name: string;
  namespace?: string;
  /** The record type written between the callee and the '(': `load Customer(`. */
  subject?: string;
}

function calleeBefore(tokens: Token[], open: number): Callee | undefined {
  const name = tokens[open - 1];
  if (name?.kind !== "Identifier") return undefined;
  const before = tokens[open - 2];
  if (before?.kind === "Dot" && tokens[open - 3]?.kind === "Identifier") {
    return { name: name.text, namespace: tokens[open - 3]!.text };
  }
  if (before?.kind === "Identifier") return { name: before.text, subject: name.text };
  return { name: name.text };
}

function resolveSignature(doc: SemanticDocument, callee: Callee, offset: number): Signature | undefined {
  if (callee.namespace) {
    const resolved = resolveNameAt(doc, callee.namespace, offset);
    if (resolved?.kind !== "namespace") return undefined;
    const member = resolved.namespace.members.get(callee.name);
    return member ? builtinSignatureInfo(member) : undefined;
  }
  const resolved = resolveNameAt(doc, callee.name, offset);
  switch (resolved?.kind) {
    case "function":
      return callee.subject ? undefined : functionSignatureInfo(resolved.function);
    case "builtin": {
      if (resolved.builtin.kind !== "recordOperation" || !callee.subject) return builtinSignatureInfo(resolved.builtin);
      const record = doc.schema.getRecordByName(callee.subject);
      return builtinSignatureInfo(resolved.builtin, record?.name);
    }
    case "recordType":
      return callee.subject ? undefined : referenceSignatureInfo(resolved.record);
    default:
      return undefined;
  }
}
