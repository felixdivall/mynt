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
  /**
   * Display text of select fields, by field id: one string for a select,
   * an array for a multiselect. A field with an entry here is a select
   * field: `getText` answers it, `lookupFields` reports it in NetSuite's
   * `{ value, text }` array shape, and a search result's `getText` sees it.
   */
  readonly texts = new Map<string, string | string[]>();
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
    texts: Record<string, string | string[]> = {},
  ) {
    this.id = id;
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
    for (const [sublistId, rows] of Object.entries(sublists)) this.lines.set(sublistId, rows.map((row) => ({ ...row })));
    for (const [k, v] of Object.entries(texts)) this.texts.set(k, v);
  }

  /** Mirrors Record.getText for select fields: the display text, or an array of them for a multiselect. */
  getText(options: { fieldId: string }): string | string[] | undefined {
    return this.texts.get(options.fieldId);
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
    SUBSIDIARY: "subsidiary",
    CUSTOMER_CATEGORY: "customercategory",
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

  seed(
    type: string,
    id: string,
    values: Record<string, unknown>,
    sublists: Record<string, Record<string, unknown>[]> = {},
    texts: Record<string, string | string[]> = {},
  ): FakeRecord {
    const record = new FakeRecord(type, values, id, undefined, sublists, texts);
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
  readonly Type = { CUSTOMER: "customer", SALES_ORDER: "salesorder", INVOICE: "invoice", SUBSIDIARY: "subsidiary", CUSTOMER_CATEGORY: "customercategory" } as const;
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

// ---- N/search --------------------------------------------------------------

/** A `search.Column`, as `search.createColumn` makes it, or as a saved search carries it (with a join, summary, or formula). */
export class FakeSearchColumn {
  /** Mirrors `Column.sort`, which SuiteScript lets a script set on a loaded search's column. */
  sort: string | undefined;

  constructor(
    readonly name: string,
    sort: string | undefined = undefined,
    readonly join: string | undefined = undefined,
    readonly summary: string | undefined = undefined,
    readonly formula: string | undefined = undefined,
  ) {
    this.sort = sort;
  }
}

/** One `search.Result`: an `id`, `getValue(column)`, and `getText(column)` for the search's columns. */
export class FakeSearchResult {
  constructor(
    readonly id: string,
    private readonly values: Record<string, unknown>,
    private readonly texts: Record<string, unknown> = {},
  ) {}

  private static key(column: FakeSearchColumn | string): string {
    if (typeof column === "string") return column;
    const name = column.join ? `${column.join}.${column.name}` : column.name;
    return column.summary ? `${column.summary}(${name})` : name;
  }

  getValue(column: FakeSearchColumn | string): unknown {
    return this.values[FakeSearchResult.key(column)];
  }

  /** Display text of a select column, as NetSuite supplies it beside the value; undefined for other columns. */
  getText(column: FakeSearchColumn | string): unknown {
    return this.texts[FakeSearchResult.key(column)];
  }
}

/**
 * A filter expression in N/search's own shape: `[name, operator, value]`, or
 * `[expression, "and" | "or", expression]`. Exactly what Mynt emits; longer
 * chains and `not` are refused so a change in the emitter is noticed.
 */
export type FilterExpression = unknown[];

/** A stored saved search: what `search.load` hands out a copy of. */
export interface SavedSearchDefinition {
  searchType: string;
  /** A standalone search type, which `search.load` must be told the type of. */
  standalone?: boolean;
  columns: { name: string; join?: string; summary?: string; formula?: string }[];
  filters: FilterExpression | undefined;
  title?: string;
}

/**
 * One search object, created or loaded, with exactly the surface Mynt
 * emits: `searchType`, mutable `columns`, `filterExpression` (get and
 * set, replacing `filters`), and `runPaged`. A loaded search is a copy of
 * its stored definition, so changes to it never reach the registry.
 */
export class FakeSearch {
  columns: FakeSearchColumn[];
  filters: FilterExpression | undefined;

  constructor(
    readonly type: string,
    columns: FakeSearchColumn[],
    filters: FilterExpression | undefined,
    private readonly module: FakeSearchModule,
    readonly title: string | undefined = undefined,
  ) {
    this.columns = columns;
    this.filters = filters;
  }

  /** Mirrors `Search.searchType`. */
  get searchType(): string {
    return this.type;
  }

  /** Mirrors `Search.filterExpression`: the filters as an expression array (empty when there are none); setting it replaces the filters. */
  get filterExpression(): FilterExpression {
    return this.filters ?? [];
  }

  set filterExpression(expression: FilterExpression) {
    this.filters = expression.length === 0 ? undefined : expression;
  }

  /** Mirrors `Search.run()`: a result set whose `getRange` fetches a slice, which is how `first` reads one row. */
  run() {
    const results = this.module.execute(this);
    return { getRange: (options: { start: number; end: number }) => results.slice(options.start, options.end) };
  }

  runPaged(options: { pageSize: number }) {
    if (options.pageSize < 5 || options.pageSize > 1000) throw new Error(`Fake NetSuite: runPaged pageSize must be between 5 and 1000, got ${options.pageSize}`);
    const results = this.module.execute(this);
    const pages: FakeSearchResult[][] = [];
    for (let i = 0; i < results.length; i += options.pageSize) pages.push(results.slice(i, i + options.pageSize));
    if (pages.length === 0) pages.push([]);
    return {
      pageRanges: pages.map((_, index) => ({ index })),
      fetch: ({ index }: { index: number }) => ({ data: pages[index]! }),
    };
  }
}

export interface LookupFieldsCall {
  type: string;
  id: string;
  columns: string[];
}

/**
 * Fake `N/search`: `lookupFields` and `create`/`runPaged` over the record
 * store, with the operators Mynt emits. Searching never mutates anything.
 * Values come back as the store holds them; whether a live account returns
 * numbers as strings is not modeled here.
 */
export class FakeSearchModule {
  readonly Type = { CUSTOMER: "customer", SALES_ORDER: "salesorder", INVOICE: "invoice", SUBSIDIARY: "subsidiary", CUSTOMER_CATEGORY: "customercategory" } as const;
  readonly Operator = {
    IS: "is",
    ISNOT: "isnot",
    ISEMPTY: "isempty",
    ISNOTEMPTY: "isnotempty",
    EQUALTO: "equalto",
    NOTEQUALTO: "notequalto",
    LESSTHAN: "lessthan",
    LESSTHANOREQUALTO: "lessthanorequalto",
    GREATERTHAN: "greaterthan",
    GREATERTHANOREQUALTO: "greaterthanorequalto",
    ANYOF: "anyof",
    NONEOF: "noneof",
  } as const;
  readonly Sort = { ASC: "ASC", DESC: "DESC", NONE: "NONE" } as const;
  readonly Summary = { GROUP: "GROUP", SUM: "SUM", COUNT: "COUNT", MIN: "MIN", MAX: "MAX", AVG: "AVG" } as const;
  readonly lookupCalls: LookupFieldsCall[] = [];
  readonly runs: { type: string; columns: string[]; filters: FilterExpression | undefined }[] = [];
  readonly loadCalls: string[] = [];
  /** The full options each `load` received, to prove when a `type` was passed. */
  readonly loadOptions: { id: string; type?: string }[] = [];
  /** Stored saved searches by script id. `load` hands out copies; nothing written to a copy comes back here. */
  readonly savedSearches = new Map<string, SavedSearchDefinition>();
  /**
   * Which joins exist, as NetSuite knows them: for a search type, a join id
   * reaches the record of `target` type whose id the base record's `field`
   * holds. Registered by tests, since the fake has no metadata of its own.
   */
  readonly joins = new Map<string, Map<string, { field: string; target: string }>>();
  /** Search type families: a `transaction` search covers every transaction record type, as in NetSuite. */
  readonly families = new Map<string, string[]>([["transaction", ["salesorder", "invoice"]]]);

  /** Declares that searches of `type` can join through `joinId` to `target` records via the base field `field`. */
  relate(type: string, joinId: string, field: string, target: string): void {
    const byType = this.joins.get(type) ?? new Map<string, { field: string; target: string }>();
    byType.set(joinId, { field, target });
    this.joins.set(type, byType);
  }

  constructor(private readonly records: FakeRecordModule) {}

  createColumn = (options: { name: string; sort?: string; join?: string; summary?: string; formula?: string }): FakeSearchColumn =>
    new FakeSearchColumn(options.name, options.sort, options.join, options.summary, options.formula);

  /** Stores a saved search definition under its script id, for `load`. */
  saveSearch(id: string, definition: SavedSearchDefinition): void {
    this.savedSearches.set(id, JSON.parse(JSON.stringify(definition)));
  }

  /** The stored definition, as a plain object, for proving it was not changed. */
  savedDefinition(id: string): SavedSearchDefinition | undefined {
    const stored = this.savedSearches.get(id);
    return stored && JSON.parse(JSON.stringify(stored));
  }

  /** Fake `search.load`: a fresh search object from the stored definition; an unknown id throws, as NetSuite would. */
  load = (options: { id: string | number; type?: string }): FakeSearch => {
    const id = String(options.id);
    this.loadCalls.push(id);
    this.loadOptions.push(options.type !== undefined ? { id, type: options.type } : { id });
    const stored = this.savedSearches.get(id);
    if (!stored) throw new Error(`Fake NetSuite has no saved search ${id}`);
    // A standalone search type must be named to load; naming the wrong one is an error, as in NetSuite.
    if (stored.standalone && options.type === undefined) throw new Error(`Fake NetSuite: saved search ${id} is a standalone search type and needs type to load`);
    if (options.type !== undefined && options.type !== stored.searchType) throw new Error(`Fake NetSuite: saved search ${id} is not a ${options.type} search`);
    const copy = JSON.parse(JSON.stringify(stored)) as SavedSearchDefinition;
    return new FakeSearch(
      copy.searchType,
      copy.columns.map((c) => new FakeSearchColumn(c.name, undefined, c.join, c.summary, c.formula)),
      copy.filters,
      this,
      copy.title,
    );
  };

  create = (options: { type: string; columns: (FakeSearchColumn | string)[]; filters?: FilterExpression }): FakeSearch =>
    new FakeSearch(
      options.type,
      options.columns.map((c) => (typeof c === "string" ? new FakeSearchColumn(c) : c)),
      options.filters,
      this,
    );

  /**
   * Fake `search.lookupFields`: the requested columns of one stored record,
   * without "loading" it. A select field (one with display text) comes back
   * in NetSuite's documented shape, an array of `{ value, text }` objects,
   * with one element per selected reference; scalars come back as stored.
   */
  lookupFields = (options: { type: string; id: string | number; columns: string[] }): Record<string, unknown> => {
    const id = String(options.id);
    this.lookupCalls.push({ type: options.type, id, columns: [...options.columns] });
    const record = this.records.all(options.type).find((entry) => entry.id === id)?.record;
    if (!record) throw new Error(`Fake NetSuite has no ${options.type} record with id ${id} to look up`);
    return Object.fromEntries(
      options.columns.map((column) => {
        const value = record.getValue({ fieldId: column });
        const text = record.texts.get(column);
        if (text === undefined) return [column, value];
        const values = Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value];
        const texts = Array.isArray(text) ? text : [text];
        return [column, values.map((v, index) => ({ value: String(v), text: texts[index] ?? "" }))];
      }),
    );
  };

  /** A column's key in a result: `name`, or `join.name` for a joined column, which is also how a filter names it; a summary column is `SUM(name)`. */
  private static key(column: FakeSearchColumn): string {
    const name = column.join ? `${column.join}.${column.name}` : column.name;
    return column.summary ? `${column.summary}(${name})` : name;
  }

  /** The source key a column reads from a row: `name` or `join.name`, summary or not. */
  private static sourceKey(column: FakeSearchColumn): string {
    return column.join ? `${column.join}.${column.name}` : column.name;
  }

  /** When set, the next search execution throws with this message, as NetSuite does for an invalid search; cleared after one throw. */
  failWith: string | undefined;

  execute(search: FakeSearch): FakeSearchResult[] {
    this.runs.push({ type: search.type, columns: search.columns.map((c) => FakeSearchModule.key(c)), filters: search.filters });
    if (this.failWith !== undefined) {
      const message = this.failWith;
      this.failWith = undefined;
      const error = new Error(message);
      error.name = "SSS_INVALID_SRCH_FILTER";
      throw error;
    }
    const types = this.families.get(search.type) ?? [search.type];
    let rows = types
      .flatMap((type) => this.records.all(type).map((entry) => ({ ...entry, joins: this.joins.get(type) ?? new Map<string, { field: string; target: string }>() })))
      .map(({ id, record, joins }) => {
        const values: Record<string, unknown> = { internalid: id, ...record.snapshot() };
        const texts: Record<string, unknown> = Object.fromEntries(record.texts);
        // Joined values: every field of the record the join reaches, under `join.field`.
        for (const [joinId, { field, target }] of joins) {
          const joined = this.records.all(target).find((entry) => entry.id === String(record.getValue({ fieldId: field }) ?? ""))?.record;
          if (!joined) continue;
          for (const [name, value] of Object.entries(joined.snapshot())) values[`${joinId}.${name}`] = value;
          for (const [name, text] of joined.texts) texts[`${joinId}.${name}`] = text;
        }
        return { id, values, texts };
      })
      .filter((row) => !search.filters || evaluateFilter(row.values, search.filters));
    // A summary search: every column must be a summary column (NetSuite refuses a mix), rows collapse into one per
    // distinct combination of GROUP values, and each aggregate column computes over its bucket. A summary result has
    // no record id: a bucket is not a record.
    // (A loaded definition that mixes summary and plain columns is read as rows, as the earlier saved-search tests pin; NetSuite itself would not store one.)
    if (search.columns.length > 0 && search.columns.every((c) => c.summary)) {
      const groups = search.columns.filter((c) => c.summary === "GROUP");
      const buckets = new Map<string, { values: Record<string, unknown>; texts: Record<string, unknown>; rows: typeof rows }>();
      for (const row of rows) {
        const key = JSON.stringify(groups.map((c) => String(row.values[FakeSearchModule.sourceKey(c)] ?? "")));
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { values: {}, texts: {}, rows: [] };
          for (const c of groups) {
            bucket.values[FakeSearchModule.key(c)] = row.values[FakeSearchModule.sourceKey(c)];
            if (FakeSearchModule.sourceKey(c) in row.texts) bucket.texts[FakeSearchModule.key(c)] = row.texts[FakeSearchModule.sourceKey(c)];
          }
          buckets.set(key, bucket);
        }
        bucket.rows.push(row);
      }
      // No GROUP column: one bucket always, as SQL aggregates over an empty set yield one row (COUNT 0, the rest empty). ASSUMED of NetSuite, not verified live.
      if (groups.length === 0 && buckets.size === 0) buckets.set("[]", { values: {}, texts: {}, rows: [] });
      const numeric = (c: FakeSearchColumn, values: unknown[]): number[] =>
        values.map((v) => {
          if (v === "" || v === null || v === undefined || !Number.isFinite(Number(v))) throw new Error(`Fake NetSuite: ${c.summary} needs numeric values; '${FakeSearchModule.sourceKey(c)}' has ${JSON.stringify(v)}`);
          return Number(v);
        });
      const present = (values: unknown[]): unknown[] => values.filter((v) => v !== "" && v !== null && v !== undefined);
      rows = [...buckets.values()].map((bucket) => {
        const values = { ...bucket.values };
        for (const c of search.columns) {
          if (c.summary === "GROUP") continue;
          const source = bucket.rows.map((r) => r.values[FakeSearchModule.sourceKey(c)]);
          const key = FakeSearchModule.key(c);
          switch (c.summary) {
            case "SUM": {
              const n = numeric(c, present(source));
              values[key] = n.length === 0 ? "" : n.reduce((a, b) => a + b, 0);
              break;
            }
            case "AVG": {
              const n = numeric(c, present(source));
              values[key] = n.length === 0 ? "" : n.reduce((a, b) => a + b, 0) / n.length;
              break;
            }
            case "COUNT":
              values[key] = present(source).length;
              break;
            case "MIN":
            case "MAX": {
              const candidates = present(source);
              if (candidates.length === 0) {
                values[key] = "";
                break;
              }
              const allNumeric = candidates.every((v) => Number.isFinite(Number(v)));
              const sorted = [...candidates].sort((a, b) => (allNumeric ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
              values[key] = c.summary === "MIN" ? sorted[0] : sorted[sorted.length - 1];
              break;
            }
            default:
              throw new Error(`Fake NetSuite: unknown summary type ${String(c.summary)}`);
          }
        }
        return { id: "", values, texts: bucket.texts };
      });
    }
    // Every sorted column, in column order, is a sort key, as in NetSuite.
    const sorts = search.columns.filter((c) => c.sort && c.sort !== "NONE");
    if (sorts.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const sort of sorts) {
          const key = FakeSearchModule.key(sort);
          const x = a.values[key] ?? a.values[FakeSearchModule.sourceKey(sort)];
          const y = b.values[key] ?? b.values[FakeSearchModule.sourceKey(sort)];
          const order = Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== "" && y !== "" ? Number(x) - Number(y) : String(x ?? "") < String(y ?? "") ? -1 : String(x ?? "") > String(y ?? "") ? 1 : 0;
          if (order !== 0) return order * (sort.sort === "DESC" ? -1 : 1);
        }
        return 0;
      });
    }
    return rows.map(
      (row) =>
        new FakeSearchResult(
          row.id,
          Object.fromEntries(search.columns.map((c) => [FakeSearchModule.key(c), row.values[FakeSearchModule.key(c)] ?? row.values[FakeSearchModule.sourceKey(c)]])),
          Object.fromEntries(search.columns.filter((c) => FakeSearchModule.key(c) in row.texts || FakeSearchModule.sourceKey(c) in row.texts).map((c) => [FakeSearchModule.key(c), row.texts[FakeSearchModule.key(c)] ?? row.texts[FakeSearchModule.sourceKey(c)]])),
        ),
    );
  }
}

function evaluateFilter(row: Record<string, unknown>, expression: FilterExpression): boolean {
  // A single wrapped term: `[[name, operator, value]]`.
  if (expression.length === 1 && Array.isArray(expression[0])) return evaluateFilter(row, expression[0] as FilterExpression);
  if (expression.length !== 3) throw new Error(`Fake N/search filter expressions have three parts, got ${JSON.stringify(expression)}`);
  const [first, second, third] = expression;
  if (Array.isArray(first)) {
    if (!Array.isArray(third) || (second !== "and" && second !== "or")) throw new Error(`Fake N/search cannot evaluate ${JSON.stringify(expression)}`);
    return second === "and" ? evaluateFilter(row, first) && evaluateFilter(row, third) : evaluateFilter(row, first) || evaluateFilter(row, third);
  }
  if (typeof first !== "string" || typeof second !== "string") throw new Error(`Fake N/search cannot evaluate ${JSON.stringify(expression)}`);
  const actual = row[first];
  const empty = actual === undefined || actual === null || actual === "";
  // Select fields hold ids; anyof/noneof take a list of ids and match on identity, a multiselect on any of its ids.
  const ids = (Array.isArray(actual) ? actual : [actual]).map((v) => String(v ?? ""));
  const wanted = (Array.isArray(third) ? third : [third]).map((v) => String(v));
  switch (second) {
    case "anyof":
      return ids.some((id) => wanted.includes(id));
    case "noneof":
      return !ids.some((id) => wanted.includes(id));
    case "is":
      // Checkbox fields take "T"/"F"; everything else compares as written.
      if (third === "T" || third === "F") return Boolean(actual) === (third === "T");
      return actual === third;
    case "isnot":
      return actual !== third;
    case "isempty":
      return empty;
    case "isnotempty":
      return !empty;
    case "equalto":
      return Number(actual) === Number(third);
    case "notequalto":
      return Number(actual) !== Number(third);
    case "lessthan":
      return Number(actual) < Number(third);
    case "lessthanorequalto":
      return Number(actual) <= Number(third);
    case "greaterthan":
      return Number(actual) > Number(third);
    case "greaterthanorequalto":
      return Number(actual) >= Number(third);
    default:
      throw new Error(`Fake N/search does not support operator ${second}`);
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
  readonly search = new FakeSearchModule(this.record);

  get modules(): Record<string, unknown> {
    return { "N/log": this.log, "N/record": this.record, "N/query": this.query, "N/search": this.search };
  }

  load(source: string): EntryPoints {
    return loadSuiteScriptModule(source, this.modules);
  }
}
