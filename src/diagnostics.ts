/**
 * Source positions, spans, and compiler diagnostics.
 *
 * Every syntax node and every bound node carries a Span so that any later
 * phase (binder, emitter, future LSP) can point back at the source.
 */

export interface Position {
  /** 0-based byte offset into the source text. */
  offset: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export function spanFrom(start: Span, end: Span): Span {
  return { start: start.start, end: end.end };
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  file: string;
  span: Span;
}

/**
 * Stable diagnostic codes. SAIL0xxx is syntax, SAIL1xxx is semantic errors,
 * SAIL2xxx is semantic warnings. Codes are never renumbered once published.
 */
export const DiagnosticCode = {
  SyntaxError: "SAIL0001",
  UnknownRecordType: "SAIL1001",
  UnknownEventName: "SAIL1002",
  MixedRecordTypes: "SAIL1003",
  UnknownField: "SAIL1004",
  ReadOnlyField: "SAIL1005",
  TypeMismatch: "SAIL1006",
  WriteInAfterSubmit: "SAIL1007",
  DuplicateEntryPoint: "SAIL1008",
  InvalidAssignmentTarget: "SAIL1009",
  UnknownIdentifier: "SAIL1010",
  MemberOnNonRecord: "SAIL1011",
  NotCallable: "SAIL1012",
  ArgumentCount: "SAIL1013",
  ArgumentType: "SAIL1014",
  MixedScriptKinds: "SAIL1015",
  UnknownBuiltinMember: "SAIL1016",
  DuplicateLocal: "SAIL1017",
  RecordTypeArgument: "SAIL1018",
  RecordOperationOnNonRecord: "SAIL1019",
  SaveContextRecord: "SAIL1020",
  ConditionNotBool: "SAIL1021",
  IncomparableTypes: "SAIL1022",
  UnsupportedComparison: "SAIL1023",
  LogicalOperandNotBool: "SAIL1024",
  CannotDelete: "SAIL1025",
  DeleteBeforeSave: "SAIL1026",
  UseAfterDelete: "SAIL1027",
  DoubleDelete: "SAIL1028",
  NotIterable: "SAIL1029",
  ReadOnlyQueryResult: "SAIL1030",
  UnsupportedQueryCondition: "SAIL1031",
  AmbiguousQueryName: "SAIL1032",
  LineNotPersistable: "SAIL1033",
  SublistOnQueryRow: "SAIL1034",
  InvalidLineInitializer: "SAIL1035",
  UseAfterRemove: "SAIL1036",
  DoubleRemove: "SAIL1037",
  ModifySublistWhileIterating: "SAIL1038",
  DuplicateFunction: "SAIL1039",
  InvalidSignatureType: "SAIL1040",
  ReturnMismatch: "SAIL1041",
  MissingReturn: "SAIL1042",
  RecursionNotSupported: "SAIL1043",
  ArgumentOrigin: "SAIL1044",
  UnsavedMutation: "SAIL2001",
} as const;

export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  constructor(readonly file: string) {}

  error(code: DiagnosticCode, message: string, span: Span): void {
    this.items.push({ code, severity: "error", message, file: this.file, span });
  }

  warning(code: DiagnosticCode, message: string, span: Span): void {
    this.items.push({ code, severity: "warning", message, file: this.file, span });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

/**
 * Renders a diagnostic in the compiler's standard text format:
 *
 *   error SAIL1004: Customer has no field 'notAField'
 *
 *     src/customer.sail:2:14
 *
 *     2 |     customer.notAField = "Nope"
 *       |              ^^^^^^^^^
 */
export function formatDiagnostic(diagnostic: Diagnostic, source: string): string {
  const { span } = diagnostic;
  const lines = source.split(/\r?\n/);
  const lineText = lines[span.start.line - 1] ?? "";
  const gutter = String(span.start.line);
  const pad = " ".repeat(gutter.length);

  const sameLine = span.end.line === span.start.line;
  const underlineLength = sameLine
    ? Math.max(1, span.end.column - span.start.column)
    : Math.max(1, lineText.length - span.start.column + 1);
  const caret = " ".repeat(span.start.column - 1) + "^".repeat(underlineLength);

  return [
    `${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`,
    ``,
    `  ${diagnostic.file}:${span.start.line}:${span.start.column}`,
    ``,
    `  ${gutter} | ${lineText}`,
    `  ${pad} | ${caret}`,
  ].join("\n");
}
