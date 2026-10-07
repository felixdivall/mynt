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
 * Stable diagnostic codes. MYNT0xxx is syntax, MYNT1xxx is semantic errors,
 * MYNT2xxx is semantic warnings. Codes are never renumbered once published.
 */
export const DiagnosticCode = {
  SyntaxError: "MYNT0001",
  UnknownRecordType: "MYNT1001",
  UnknownEventName: "MYNT1002",
  MixedRecordTypes: "MYNT1003",
  UnknownField: "MYNT1004",
  ReadOnlyField: "MYNT1005",
  TypeMismatch: "MYNT1006",
  WriteInAfterSubmit: "MYNT1007",
  DuplicateEntryPoint: "MYNT1008",
  InvalidAssignmentTarget: "MYNT1009",
  UnknownIdentifier: "MYNT1010",
  MemberOnNonRecord: "MYNT1011",
  NotCallable: "MYNT1012",
  ArgumentCount: "MYNT1013",
  ArgumentType: "MYNT1014",
  MixedScriptKinds: "MYNT1015",
  UnknownBuiltinMember: "MYNT1016",
  DuplicateLocal: "MYNT1017",
  RecordTypeArgument: "MYNT1018",
  RecordOperationOnNonRecord: "MYNT1019",
  SaveContextRecord: "MYNT1020",
  ConditionNotBool: "MYNT1021",
  IncomparableTypes: "MYNT1022",
  UnsupportedComparison: "MYNT1023",
  LogicalOperandNotBool: "MYNT1024",
  CannotDelete: "MYNT1025",
  DeleteBeforeSave: "MYNT1026",
  UseAfterDelete: "MYNT1027",
  DoubleDelete: "MYNT1028",
  NotIterable: "MYNT1029",
  ReadOnlyQueryResult: "MYNT1030",
  UnsupportedQueryCondition: "MYNT1031",
  AmbiguousQueryName: "MYNT1032",
  LineNotPersistable: "MYNT1033",
  SublistOnQueryRow: "MYNT1034",
  InvalidLineInitializer: "MYNT1035",
  UseAfterRemove: "MYNT1036",
  DoubleRemove: "MYNT1037",
  ModifySublistWhileIterating: "MYNT1038",
  DuplicateFunction: "MYNT1039",
  InvalidSignatureType: "MYNT1040",
  ReturnMismatch: "MYNT1041",
  MissingReturn: "MYNT1042",
  RecursionNotSupported: "MYNT1043",
  ArgumentOrigin: "MYNT1044",
  UnsavedMutation: "MYNT2001",
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
 *   error MYNT1004: Customer has no field 'notAField'
 *
 *     src/customer.mn:2:14
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
