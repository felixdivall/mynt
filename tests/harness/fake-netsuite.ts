/**
 * A minimal fake of the SuiteScript 2.1 runtime, enough to load a generated
 * module, supply the `N/*` modules it asks for, and invoke its entry points.
 *
 * Add future modules (N/record, N/email, N/https) as further fakes registered
 * in `FakeNetSuite.modules`; the loader itself does not change.
 */

// ---- N/record-shaped record ------------------------------------------------

export interface SetValueCall {
  fieldId: string;
  value: unknown;
}

export interface SetSublistValueCall {
  sublistId: string;
  fieldId: string;
  line: number;
  value: unknown;
}

export class FakeRecord {
  readonly setValueCalls: SetValueCall[] = [];
  readonly setSublistValueCalls: SetSublistValueCall[] = [];
  readonly insertLineCalls: { sublistId: string; line: number }[] = [];
  readonly removeLineCalls: { sublistId: string; line: number }[] = [];
  /** Field values as of the last save(); undefined until saved. */
  persisted: Record<string, unknown> | undefined;
  /** Sublist lines as of the last save(); undefined until saved. */
  persistedLines: Record<string, Record<string, unknown>[]> | undefined;
  /** In-memory sublist lines, keyed by sublist id. */
  private readonly lines = new Map<string, Record<string, unknown>[]>();
  saveCount = 0;
  /** Internal id; a created record has none until its first save. */
  id: string | undefined;
  private readonly values = new Map<string, unknown>();

  constructor(
    readonly type: string,
    initial: Record<string, unknown> = {},
    id: string | undefined = undefined,
    /** Called on the first save of a record without an id: assigns one and files the record. */
    private readonly onFirstSave: ((record: FakeRecord) => string) | undefined = undefined,
    sublists: Record<string, Record<string, unknown>[]> = {},
  ) {
    this.id = id;
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
    for (const [sublistId, rows] of Object.entries(sublists)) this.lines.set(sublistId, rows.map((row) => ({ ...row })));
  }

  /** Mirrors Record.save(): persists the in-memory values and lines and returns the internal id. */
  save(): number {
    this.saveCount++;
    if (this.id === undefined && this.onFirstSave) this.id = this.onFirstSave(this);
    this.persisted = Object.fromEntries(this.values);
    this.persistedLines = this.linesSnapshot();
    return Number(this.id ?? 0);
  }

  /** Current in-memory lines of every sublist. */
  linesSnapshot(): Record<string, Record<string, unknown>[]> {
    return Object.fromEntries([...this.lines].map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]));
  }

  getLineCount(options: { sublistId: string }): number {
    return this.lines.get(options.sublistId)?.length ?? 0;
  }

  private lineAt(sublistId: string, line: number): Record<string, unknown> {
    const row = this.lines.get(sublistId)?.[line];
    if (!row) throw new Error(`Fake NetSuite: ${this.type} has no ${sublistId} line ${line}`);
    return row;
  }

  getSublistValue(options: { sublistId: string; fieldId: string; line: number }): unknown {
    return this.lineAt(options.sublistId, options.line)[options.fieldId];
  }

  /** Standard-mode insertLine: an empty line at `line`, which may equal the count to append. */
  insertLine(options: { sublistId: string; line: number }): FakeRecord {
    this.insertLineCalls.push({ sublistId: options.sublistId, line: options.line });
    const rows = this.lines.get(options.sublistId) ?? [];
    if (options.line < 0 || options.line > rows.length) throw new Error(`Fake NetSuite: cannot insert ${options.sublistId} line ${options.line}`);
    rows.splice(options.line, 0, {});
    this.lines.set(options.sublistId, rows);
    return this;
  }

  /** Standard-mode removeLine: later lines shift down by one. */
  removeLine(options: { sublistId: string; line: number }): FakeRecord {
    this.removeLineCalls.push({ sublistId: options.sublistId, line: options.line });
    this.lineAt(options.sublistId, options.line);
    this.lines.get(options.sublistId)!.splice(options.line, 1);
    return this;
  }

  setSublistValue(options: { sublistId: string; fieldId: string; line: number; value: unknown }): FakeRecord {
    this.setSublistValueCalls.push({ sublistId: options.sublistId, fieldId: options.fieldId, line: options.line, value: options.value });
    this.lineAt(options.sublistId, options.line)[options.fieldId] = options.value;
    return this;
  }

  setValue(options: { fieldId: string; value: unknown }): FakeRecord {
    this.setValueCalls.push({ fieldId: options.fieldId, value: options.value });
    this.values.set(options.fieldId, options.value);
    return this;
  }

  getValue(options: { fieldId: string }): unknown {
    return this.values.get(options.fieldId);
  }

  /** Current in-memory values. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
}

// ---- N/record --------------------------------------------------------------

export interface LoadCall {
  type: string;
  id: string;
}

/**
 * Fake `N/record`: `record.Type` constants and `record.load`. Records are
 * seeded per (type, id); loading an unseeded record throws, as NetSuite would.
 */
export class FakeRecordModule {
  readonly Type = {
    CUSTOMER: "customer",
    SALES_ORDER: "salesorder",
    INVOICE: "invoice",
  } as const;

  readonly loadCalls: LoadCall[] = [];
  readonly createCalls: { type: string }[] = [];
  readonly copyCalls: { type: string; id: string }[] = [];
  readonly transformCalls: { fromType: string; fromId: string; toType: string }[] = [];
  readonly deleteCalls: { type: string; id: string }[] = [];
  /** Every record handed out by create(), saved or not. */
  readonly created: FakeRecord[] = [];
  private readonly store = new Map<string, FakeRecord>();
  private nextId = 1000;

  seed(type: string, id: string, values: Record<string, unknown>, sublists: Record<string, Record<string, unknown>[]> = {}): FakeRecord {
    const record = new FakeRecord(type, values, id, undefined, sublists);
    this.store.set(`${type}:${id}`, record);
    return record;
  }

  /** The field values last saved for a record, for assertions. */
  persisted(type: string, id: string): Record<string, unknown> | undefined {
    return this.store.get(`${type}:${id}`)?.persisted;
  }

  /** Fake `record.create`: a new record that is filed in the store only once saved. */
  create = (options: { type: string }): FakeRecord => {
    this.createCalls.push({ type: options.type });
    return this.newRecord(options.type, {});
  };

  /** Whether a record with this id is currently persisted. */
  exists(type: string, id: string): boolean {
    return this.store.has(`${type}:${id}`);
  }

  /** Every stored record of a type, with its id, for the fake query module. */
  all(type: string): { id: string; record: FakeRecord }[] {
    return [...this.store.entries()].filter(([key]) => key.startsWith(`${type}:`)).map(([key, record]) => ({ id: key.slice(type.length + 1), record }));
  }

  /** A new unsaved record of `type`, filed in the store on its first save. */
  private newRecord(type: string, values: Record<string, unknown>, sublists: Record<string, Record<string, unknown>[]> = {}): FakeRecord {
    const record = new FakeRecord(
      type,
      values,
      undefined,
      (saved) => {
        const id = String(this.nextId++);
        this.store.set(`${type}:${id}`, saved);
        return id;
      },
      sublists,
    );
    this.created.push(record);
    return record;
  }

  private existing(type: string, id: string | number, what: string): FakeRecord {
    const record = this.store.get(`${type}:${String(id)}`);
    if (!record) throw new Error(`Fake NetSuite has no ${type} record with id ${String(id)} to ${what}`);
    return record;
  }

  /** Fake `record.copy`: a new unsaved record with the source's current values. */
  copy = (options: { type: string; id: string | number }): FakeRecord => {
    this.copyCalls.push({ type: options.type, id: String(options.id) });
    const source = this.existing(options.type, options.id, "copy");
    return this.newRecord(options.type, source.snapshot(), source.linesSnapshot());
  };

  /** Fake `record.transform`: a new unsaved record of the target type carrying the source's values and a `createdfrom`. */
  transform = (options: { fromType: string; fromId: string | number; toType: string }): FakeRecord => {
    this.transformCalls.push({ fromType: options.fromType, fromId: String(options.fromId), toType: options.toType });
    const source = this.existing(options.fromType, options.fromId, "transform");
    return this.newRecord(options.toType, { ...source.snapshot(), createdfrom: String(options.fromId) }, source.linesSnapshot());
  };

  /** Fake `record.delete`: removes a persisted record; deleting an unknown id throws, as NetSuite would. */
  delete = (options: { type: string; id: string | number }): number => {
    this.deleteCalls.push({ type: options.type, id: String(options.id) });
    this.existing(options.type, options.id, "delete");
    this.store.delete(`${options.type}:${String(options.id)}`);
    return Number(options.id);
  };

  load = (options: { type: string; id: string | number }): FakeRecord => {
    const id = String(options.id);
    this.loadCalls.push({ type: options.type, id });
    const record = this.store.get(`${options.type}:${id}`);
    if (!record) throw new Error(`Fake NetSuite has no ${options.type} record with id ${id}`);
    return record;
  };
}

// ---- N/log -----------------------------------------------------------------

export type LogLevel = "debug" | "audit" | "error" | "emergency";

export interface LogCall {
  level: LogLevel;
  title: string;
  details: unknown;
}

/** Fake `N/log`. Accepts both the options-object and positional forms. */
export class FakeLog {
  readonly calls: LogCall[] = [];

  debug = this.method("debug");
  audit = this.method("audit");
  error = this.method("error");
  emergency = this.method("emergency");

  private method(level: LogLevel) {
    return (titleOrOptions: string | { title: string; details?: unknown }, details?: unknown): void => {
      if (typeof titleOrOptions === "string") {
        this.calls.push({ level, title: titleOrOptions, details });
      } else {
        this.calls.push({ level, title: titleOrOptions.title, details: titleOrOptions.details });
      }
    };
  }
}

// ---- N/query ---------------------------------------------------------------

type FakeCondition =
  | { kind: "condition"; fieldId: string; operator: string; values: unknown[] }
  | { kind: "and" | "or"; operands: FakeCondition[] }
  | { kind: "not"; operand: FakeCondition };

/** One query under construction, with exactly the surface Mynt emits. */
export class FakeQuery {
  columns: { fieldId: string; alias: string }[] = [];
  condition: FakeCondition | undefined;
  sort: { column: { fieldId: string }; ascending: boolean }[] = [];

  constructor(
    readonly type: string,
    private readonly module: FakeQueryModule,
  ) {}

  createCondition(options: { fieldId: string; operator: string; values?: unknown[] }): FakeCondition {
    return { kind: "condition", fieldId: options.fieldId, operator: options.operator, values: options.values ?? [] };
  }

  createColumn(options: { fieldId: string; alias?: string }): { fieldId: string; alias: string } {
    return { fieldId: options.fieldId, alias: options.alias ?? options.fieldId };
  }

  createSort(options: { column: { fieldId: string }; ascending?: boolean }): { column: { fieldId: string }; ascending: boolean } {
    return { column: options.column, ascending: options.ascending ?? true };
  }

  and(...operands: FakeCondition[]): FakeCondition {
    return { kind: "and", operands };
  }

  or(...operands: FakeCondition[]): FakeCondition {
    return { kind: "or", operands };
  }

  not(operand: FakeCondition): FakeCondition {
    return { kind: "not", operand };
  }

  runPaged(options: { pageSize: number }) {
    const rows = this.module.execute(this);
    const pages: Record<string, unknown>[][] = [];
    for (let i = 0; i < rows.length; i += options.pageSize) pages.push(rows.slice(i, i + options.pageSize));
    if (pages.length === 0) pages.push([]);
    return {
      pageRanges: pages.map((_, index) => ({ index })),
      fetch: ({ index }: { index: number }) => ({ data: { results: pages[index]!.map((row) => ({ asMap: () => row })) } }),
    };
  }
}

/** Fake `N/query`: evaluates the conditions Mynt emits against the record store. Querying never mutates anything. */
export class FakeQueryModule {
  readonly Type = { CUSTOMER: "customer", SALES_ORDER: "salesorder", INVOICE: "invoice" } as const;
  readonly Operator = {
    EQUAL: "EQUAL",
    EQUAL_NOT: "EQUAL_NOT",
    EMPTY: "EMPTY",
    EMPTY_NOT: "EMPTY_NOT",
    IS: "IS",
    LESS: "LESS",
    LESS_OR_EQUAL: "LESS_OR_EQUAL",
    GREATER: "GREATER",
    GREATER_OR_EQUAL: "GREATER_OR_EQUAL",
  } as const;
  readonly runs: { type: string; columns: string[]; sort: string[] }[] = [];

  constructor(private readonly records: FakeRecordModule) {}

  create = (options: { type: string }): FakeQuery => new FakeQuery(options.type, this);

  execute(query: FakeQuery): Record<string, unknown>[] {
    this.runs.push({ type: query.type, columns: query.columns.map((c) => c.fieldId), sort: query.sort.map((s) => s.column.fieldId) });
    const rows = this.records
      .all(query.type)
      .map(({ id, record }) => ({ id, ...record.snapshot() }))
      .filter((row) => !query.condition || matches(row, query.condition))
      .map((row) => Object.fromEntries(query.columns.map((c) => [c.alias, c.fieldId === "id" ? row.id : row[c.fieldId]])));
    for (const sort of [...query.sort].reverse()) {
      rows.sort((a, b) => {
        const x = a[sort.column.fieldId] ?? "";
        const y = b[sort.column.fieldId] ?? "";
        // Internal ids are numeric; sort them as NetSuite does, not as text.
        const numeric = Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== "" && y !== "";
        const order = numeric ? Number(x) - Number(y) : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
        return order * (sort.ascending ? 1 : -1);
      });
    }
    return rows;
  }
}

function matches(row: Record<string, unknown>, condition: FakeCondition): boolean {
  switch (condition.kind) {
    case "and":
      return condition.operands.every((c) => matches(row, c));
    case "or":
      return condition.operands.some((c) => matches(row, c));
    case "not":
      return !matches(row, condition.operand);
    case "condition": {
      const actual = row[condition.fieldId];
      const expected = condition.values[0];
      const empty = actual === undefined || actual === null || actual === "";
      switch (condition.operator) {
        case "EMPTY":
          return empty;
        case "EMPTY_NOT":
          return !empty;
        case "IS":
          return Boolean(actual) === Boolean(expected);
        case "EQUAL":
          return actual === expected;
        case "EQUAL_NOT":
          return actual !== expected;
        case "LESS":
          return Number(actual) < Number(expected);
        case "LESS_OR_EQUAL":
          return Number(actual) <= Number(expected);
        case "GREATER":
          return Number(actual) > Number(expected);
        case "GREATER_OR_EQUAL":
          return Number(actual) >= Number(expected);
        default:
          throw new Error(`Fake N/query does not support operator ${condition.operator}`);
      }
    }
  }
}

// ---- contexts --------------------------------------------------------------

/** Mirrors `context.UserEventType` from the user event context. */
export const UserEventType = {
  CREATE: "create",
  EDIT: "edit",
  VIEW: "view",
  COPY: "copy",
  DELETE: "delete",
  XEDIT: "xedit",
  APPROVE: "approve",
  CANCEL: "cancel",
  REJECT: "reject",
  PACK: "pack",
  SHIP: "ship",
  DROPSHIP: "dropship",
  SPECIALORDER: "specialorder",
  ORDERITEMS: "orderitems",
  PAYBILLS: "paybills",
} as const;

export interface UserEventContext {
  type: string;
  UserEventType: typeof UserEventType;
  newRecord: FakeRecord;
  oldRecord: FakeRecord | null;
}

export function userEventContext(type: string, newRecord: FakeRecord): UserEventContext {
  return { type, UserEventType, newRecord, oldRecord: null };
}

/** Mirrors the scheduled script `execute` context. */
export interface ScheduledContext {
  type: "SCHEDULED" | "ON_DEMAND" | "USER_INTERFACE" | "ABORTED" | "SKIPPED";
}

export function scheduledContext(type: ScheduledContext["type"] = "SCHEDULED"): ScheduledContext {
  return { type };
}

// ---- module loader ---------------------------------------------------------

export type EntryPoints = Record<string, (context: unknown) => void>;

/**
 * Loads an AMD-style SuiteScript module. `modules` resolves the dependency
 * names passed to `define`, for example `{ "N/log": fakeLog }`. Asking for a
 * module the fake does not provide is an error, which is what catches a
 * missing dependency inference.
 */
export function loadSuiteScriptModule(source: string, modules: Record<string, unknown> = {}): EntryPoints {
  let exported: EntryPoints | undefined;

  const define = (dependencies: string[], factory: (...deps: unknown[]) => EntryPoints): void => {
    const resolved = dependencies.map((name) => {
      if (!(name in modules)) throw new Error(`Fake NetSuite has no module '${name}'`);
      return modules[name];
    });
    exported = factory(...resolved);
  };

  // The generated file is a plain script whose only free variable is `define`.
  new Function("define", source)(define);

  if (!exported) throw new Error("Module did not call define()");
  return exported;
}

/** One fake account: every module the generated code may ask for, plus their recorded calls. */
export class FakeNetSuite {
  readonly log = new FakeLog();
  readonly record = new FakeRecordModule();
  readonly query = new FakeQueryModule(this.record);

  get modules(): Record<string, unknown> {
    return { "N/log": this.log, "N/record": this.record, "N/query": this.query };
  }

  load(source: string): EntryPoints {
    return loadSuiteScriptModule(source, this.modules);
  }
}
