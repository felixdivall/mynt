/**
 * Operations are verbs; platform objects are types. `load T(id)` is one
 * operation whose target type picks the platform call (a record, a saved
 * `Search`, a `File`); `lookup` is the explicit spelling of a projection,
 * with the fields in `[...]` or a `select`; `let { a, b: c } = value`
 * binds a projection's fields as ordinary locals. Uses the reference
 * fixture (tests/helpers.ts) and the fake runtime.
 */
import { parse as parseJs } from "acorn";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { hoverAt } from "../src/lsp/hover.js";
import { analyze, typeAt } from "../src/semantic/query.js";
import { referencesOf, renameConflict, renameRefusal, symbolAt } from "../src/semantic/symbols.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { typeName } from "../src/semantic/types.js";
import { referenceSchema } from "./helpers.js";
import { FakeNetSuite, scheduledContext } from "./harness/fake-netsuite.js";

const EXAMPLE = readFileSync(new URL("../examples/lookup-fields.mn", import.meta.url), "utf8");
const scheduled = (body: string) => `scheduled {\n${body}\n}\n`;
const compileRefs = (source: string) => compile(source, { file: "t.mn", schema: referenceSchema });
const messages = (source: string) => compileRefs(source).diagnostics.map((d) => `${d.code} ${d.message}`);
const first = (source: string) => messages(source)[0] ?? "";
const output = (source: string) => {
  const result = compileRefs(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
  return result.output!;
};
const body = (source: string) => output(source).split("function execute(context) {")[1]!.split("return { execute };")[0]!;
function at(source: string) {
  const offset = source.indexOf("§");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { doc: analyze(text, "t.mn", referenceSchema), offset, text };
}
const labels = (source: string) => completionsAt(at(source).doc, at(source).offset).map((i) => i.label);
const hover = (source: string) => hoverAt(at(source).doc, at(source).offset)?.contents;
const type = (source: string) => {
  const { doc, offset } = at(source);
  const t = typeAt(doc, offset);
  return t && typeName(t);
};
const tokens = (text: string) =>
  semanticTokens(analyze(text, "t.mn", referenceSchema)).map((t) => `${text.slice(t.span.start.offset, t.span.end.offset)}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`);

function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "hello", entityid: "A", subsidiary: "1" }, {}, { subsidiary: "Parent Company" });
  netsuite.search.saveSearch("customsearch_customers", { searchType: "customer", columns: [{ name: "entityid" }], filters: undefined });
  netsuite.file.seed("456", "report.csv");
  return netsuite;
}
const run = (js: string, netsuite = seeded()) => {
  netsuite.load(js).execute!(scheduledContext());
  return netsuite;
};
/** The bound initializer of the declaration at `index` in the entry point body. */
const initializer = (source: string, index = 0) => {
  const result = compileRefs(source);
  const statement = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[index] : undefined;
  return (statement as { initializer?: unknown } | undefined)?.initializer;
};

describe("load: one operation, dispatched by type", () => {
  it("a record type is N/record.load, a mutable owned record with its lifecycle", () => {
    expect(initializer(scheduled(`    let c = load Customer(123)`))).toMatchObject({ kind: "BuiltinCall", builtin: { id: "load" }, type: { kind: "Record", origin: "owned", record: { name: "Customer" } } });
    expect(body(scheduled(`    let c = load Customer(123)\n    c.comments = "x"\n    save c`))).toContain("record.load({");
    expect(messages(scheduled(`    let c = load Customer(123)\n    c.comments = "x"`))[0]).toContain("MYNT2001");
  });

  it("Search is N/search.load through the saved-search helper, a search source of the snapshot's record", () => {
    const source = scheduled(`    let s = load Search("customsearch_customers")\n    for c in s {\n        log.debug(c.entityid)\n    }`);
    expect(initializer(source)).toMatchObject({ kind: "Query", source: { kind: "saved", recordFrom: "snapshot" }, recordType: { record: { name: "Customer" } } });
    expect(type(source.replace("for c in s", "for c in §s"))).toBe("Sequence<Customer>");
    const result = compileRefs(source);
    expect([...result.unit!.dependencies].sort()).toEqual(["N/log", "N/search"]);
    expect(run(output(source)).log.calls.map((c) => c.details)).toEqual(["A"]);
  });

  it("File is N/file.load, an opaque File value with nothing modeled on it yet", () => {
    const source = scheduled(`    let f = load File(456)\n    log.debug("loaded")`);
    expect(initializer(source)).toMatchObject({ kind: "FileLoad", type: "File" });
    expect(hover(source.replace("let f", "let §f"))).toContain("f: File");
    expect(body(source)).toContain("const f = file.load({\n            id: 456\n        });");
    const result = compileRefs(source);
    expect([...result.unit!.dependencies].sort()).toEqual(["N/file", "N/log"]);
    const netsuite = run(output(source));
    expect(netsuite.file.loadCalls).toEqual([{ id: 456 }]);
    expect(first(scheduled(`    let f = load File(456)\n    log.debug(f.name)`))).toBe(
      "MYNT1011 A File has no members in Mynt yet; it can be loaded ('load File(...)') and passed along, but its properties and contents are not modeled",
    );
    expect(first(scheduled(`    let f = load File(1.5)`))).toContain("MYNT1045");
    expect(first(scheduled(`    let f = load File()`))).toBe("MYNT1013 load File(...) expects 1 argument, the file's internal id, but received 0");
  });

  it("unsupported targets: a platform type with another operation, an unknown type, a platform type in a record position", () => {
    expect(first(scheduled(`    let f = create File`))).toBe("MYNT1018 'File' is a platform type that can only be loaded: 'load File(456)'. create works on record types");
    expect(first(scheduled(`    let f = copy File(1)`))).toContain("MYNT1018 'File' is a platform type that can only be loaded");
    expect(first(scheduled(`    let x = load Nope(1)`))).toContain("MYNT1001 Unknown record type 'Nope'");
    expect(first(scheduled(`    let x = search File`))).toBe("MYNT1001 'File' is a platform type, not a record type: it has no fields and is only loaded, 'load File(456)'");
    // A File cannot be a parameter yet: function signatures take primitives and record types.
    expect(first(`fn f(x: File): string {\n    return "x"\n}\nscheduled {\n}\n`)).toContain("MYNT1040 Unknown parameter type 'File'");
  });

  it("tokens: load is a builtin operation, Search and File builtin types, record types structs", () => {
    const text = scheduled(`    let c = load Customer(1)\n    let s = load Search("customsearch_customers")\n    let f = load File(2)`);
    expect(tokens(text).filter((t) => /^(load|Customer|Search|File):/.test(t))).toEqual([
      "load:function+defaultLibrary",
      "Customer:struct",
      "load:function+defaultLibrary",
      "Search:type+defaultLibrary",
      "load:function+defaultLibrary",
      "File:type+defaultLibrary",
    ]);
    expect(hover(scheduled(`    let f = load Fi§le(2)`))).toBe(
      "```mynt\nplatform type File\n```\n\nA file in the File Cabinet, loaded by its internal id. Opaque so far: it can be loaded and passed along; its contents and properties are not modeled yet. · `load File(456)` · NetSuite module `N/file`",
    );
    expect(labels(scheduled(`    let x = load §`))).toEqual(["Customer", "SalesOrder", "MyntLog", "Invoice", "Subsidiary", "CustomerCategory", "FieldMapping", "SystemNote", "Search", "File"]);
  });
});

describe("lookup: three spellings, one operation", () => {
  const MULTI = [
    `Customer(123)[email, comments]`,
    `lookup Customer(123)[email, comments]`,
    `lookup Customer(123)\n        select email, comments`,
  ];
  const SINGLE = [`Customer(123)[email]`, `lookup Customer(123)[email]`, `lookup Customer(123)\n        select email`];

  it("multi-field forms bind to the same projection and emit the same single lookupFields call", () => {
    const bound = MULTI.map((form) => initializer(scheduled(`    let info = ${form}`)) as { kind: string; type: unknown; fields: { field: { id: string } }[]; source: string });
    for (const b of bound) expect(b).toMatchObject({ kind: "Lookup", source: "lookupFields", type: { kind: "Projection", fields: [{ field: { id: "email" } }, { field: { id: "comments" } }] } });
    const emitted = MULTI.map((form) => body(scheduled(`    let info = ${form}\n    log.debug(info.comments)`)));
    expect(new Set(emitted).size).toBe(1);
    for (const form of MULTI) {
      const netsuite = run(output(scheduled(`    let info = ${form}\n    log.debug(info.comments)`)));
      expect(netsuite.search.lookupCalls).toEqual([{ type: "customer", id: "123", columns: ["email", "comments"] }]);
      expect(netsuite.log.calls.map((c) => c.details)).toEqual(["hello"]);
    }
    expect(type(scheduled(`    let info = lookup Customer(123)\n        select email, comments\n    log.debug(in§fo.email)`))).toBe("Customer[email, comments]");
  });

  it("single-field forms all yield the field's value, never a one-field projection", () => {
    for (const form of SINGLE) expect(type(scheduled(`    let email = ${form}\n    log.debug(e§mail)`))).toBe("string");
    expect(new Set(SINGLE.map((form) => body(scheduled(`    let email = ${form}\n    log.debug(email)`)))).size).toBe(1);
    expect(type(scheduled(`    let sub = lookup Customer(123)\n        select subsidiary\n    log.debug(s§ub.text)`))).toBe("Ref<Subsidiary>");
    expect(run(output(scheduled(`    let s = lookup Customer(123)\n        select subsidiary\n    log.debug(s.text)`))).log.calls.map((c) => c.details)).toEqual(["Parent Company"]);
  });

  it("lookup on a reference local is one lookupFields call; on a loaded record or a row it reads locally", () => {
    const viaReference = run(output(scheduled(`    let customer = Customer(123)\n    let info = lookup customer\n        select email, comments\n    log.debug(info.email)`)));
    expect(viaReference.search.lookupCalls).toHaveLength(1);
    const loaded = scheduled(`    let customer = load Customer(123)\n    let info = lookup customer\n        select email, comments\n    log.debug(info.comments)`);
    expect(body(loaded)).toContain('email: customer.getValue({');
    const local = run(output(loaded));
    expect(local.search.lookupCalls).toEqual([]);
    expect(local.log.calls.map((c) => c.details)).toEqual(["hello"]);
    // A row's fields are already planned columns: no lookup per row, no N+1.
    const rows = run(output(scheduled(`    for row in search Customer {\n        let info = lookup row\n            select email, comments\n        log.debug(info.email)\n    }`)));
    expect(rows.search.lookupCalls).toEqual([]);
    expect(rows.search.runs[0]!.columns).toEqual(["internalid", "comments", "email"]);
    expect(rows.log.calls.map((c) => c.details)).toEqual(["a@x.com"]);
  });

  it("lookup requires fields once, as [...] or select, of the one record: no aggregates, joins, aliases, or other clauses", () => {
    expect(first(scheduled(`    let info = lookup Customer(123)`))).toBe(
      "MYNT1064 'lookup' requires one or more selected fields: write 'lookup Customer(...)[email, ...]' or 'lookup Customer(...) select email, ...'. Use 'load Customer(...)' to retrieve the full record",
    );
    expect(first(scheduled(`    let info = lookup Customer(123)[email]\n        select comments`))).toBe("MYNT1064 Name the fields once: in the '[...]' or in 'select', not both");
    expect(first(scheduled(`    let info = lookup Customer(123) select n = count()`))).toContain("MYNT1062 A lookup reads fields of one record; 'count(...)' aggregates rows");
    expect(first(scheduled(`    let info = lookup Customer(123) select subsidiary.name`))).toContain("MYNT1053 A lookup reads fields of the one record it names");
    expect(first(scheduled(`    let info = lookup Customer(123) select e = email`))).toContain("MYNT1063 A lookup's fields keep their own names");
    expect(first(scheduled(`    let info = lookup Customer(123) select nope`))).toContain("MYNT1004 Customer has no field 'nope'");
    expect(first(scheduled(`    let info = lookup Customer(123) select email, email`))).toContain("MYNT1047 'email' is projected twice");
    expect(first(scheduled(`    let info = lookup Customer(123)\n        where email === ""`))).toContain("MYNT1064");
    expect(first(scheduled(`    let x = "x"\n    let info = lookup x select email`))).toContain("MYNT1048");
    expect(first(scheduled(`    let info = lookup Customer(123)\n        select`))).toContain("MYNT0001 Expected the fields to select after 'select'");
  });

  it("editor: lookup is a builtin operation; select completes the record's fields, by type name or through the receiver local", () => {
    const text = scheduled(`    let lookup = "x"\n    let info = lookup Customer(123)\n        select email, comments\n    log.debug(lookup)`);
    expect(tokens(text).filter((t) => /^(lookup|select|email|comments):/.test(t))).toEqual([
      "lookup:variable+declaration",
      "lookup:function+defaultLibrary",
      "select:keyword",
      "email:property",
      "comments:property",
      "lookup:variable",
    ]);
    expect(labels(scheduled(`    let info = lookup Customer(123)\n        select §`))).toEqual(["comments", "email", "entityid", "subsidiary", "parent", "category"]);
    expect(labels(scheduled(`    let info = lookup Customer(123)\n        select email, §`))).toEqual(["comments", "entityid", "subsidiary", "parent", "category"]);
    expect(labels(scheduled(`    let c = Customer(1)\n    let info = lookup c\n        select §`))).toEqual(["comments", "email", "entityid", "subsidiary", "parent", "category"]);
    expect(labels(scheduled(`    let info = lookup Customer(123)[§`))).toEqual(["comments", "email", "entityid", "subsidiary", "parent", "category"]);
    expect(labels(scheduled(`    §`))).toContain("lookup");
    expect(hover(scheduled(`    let info = loo§kup Customer(123)\n        select email, comments`))).toBe(
      "```mynt\nlookup Customer: Customer[email, comments]\n```\n\nreads the selected fields of one Customer · one `N/search.lookupFields` call for exactly these fields · the same operation as `Customer(...)[email, comments]`",
    );
    expect(hover(scheduled(`    let c = load Customer(1)\n    let info = loo§kup c select email, comments`))).toContain("read locally from the loaded record (`getValue`), no search");
  });
});

describe("destructuring", () => {
  it("binds a projection's fields as ordinary locals, evaluating the value once, directly or through a local", () => {
    const direct = scheduled(`    let { email, comments } = lookup Customer(123)\n        select email, comments\n    log.debug(email)\n    log.debug(comments)`);
    expect(body(direct)).toContain("const { email, comments } = search.lookupFields({");
    const netsuite = run(output(direct));
    expect(netsuite.search.lookupCalls).toHaveLength(1);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "hello"]);
    expect(type(direct.replace("log.debug(email)", "log.debug(§email)"))).toBe("string");
    for (const value of [`Customer(123)[email, comments]`, `lookup Customer(123)[email, comments]`]) {
      expect(messages(scheduled(`    let { email, comments } = ${value}\n    log.debug(email)`))).toEqual([]);
    }
    const viaLocal = scheduled(`    let info = lookup Customer(123)\n        select email, comments\n    let { email, comments } = info\n    log.debug(comments)`);
    expect(body(viaLocal)).toContain("const { email, comments } = info;");
    expect(run(output(viaLocal)).log.calls.map((c) => c.details)).toEqual(["hello"]);
    const statement = compileRefs(viaLocal).unit!;
    expect(statement.kind === "Scheduled" ? statement.entryPoint.body[1] : undefined).toMatchObject({
      kind: "Destructure",
      bindings: [{ field: { id: "email" }, local: { name: "email", origin: "let" }, aliased: false }, { field: { id: "comments" }, local: { name: "comments" }, aliased: false }],
    });
  });

  it("aliases bind a field under another local name; references keep their identity and display text", () => {
    const source = scheduled(`    let { comments: note, subsidiary } = lookup Customer(123)\n        select comments, subsidiary\n    log.debug(note)\n    log.debug(subsidiary.text)\n    log.debug(subsidiary.id)`);
    expect(body(source)).toContain("const { comments: note, subsidiary } = mynt$lookup(");
    expect(run(output(source)).log.calls.map((c) => c.details)).toEqual(["hello", "Parent Company", "1"]);
    expect(type(source.replace("log.debug(subsidiary.text)", "log.debug(§subsidiary.text)"))).toBe("Ref<Subsidiary>");
    expect(first(scheduled(`    let { subsidiary } = Customer(123)[subsidiary, email]\n    log.debug(subsidiary.email)`))).toContain("MYNT1011");
  });

  it("the pattern follows the actual shape: unknown, unselected, repeated, and clashing names are refused precisely", () => {
    const info = `    let info = lookup Customer(123)\n        select email, comments\n`;
    expect(first(scheduled(`${info}    let { email, missing } = info`))).toBe("MYNT1065 'missing' is not in this projection (Customer[email, comments]); bind one of email, comments");
    expect(first(scheduled(`${info}    let { email, entityid } = info`))).toBe(
      "MYNT1065 'entityid' is not in this projection (Customer[email, comments]); bind one of email, comments. 'entityid' is a Customer field, but it was not selected; add it where the projection is made",
    );
    expect(first(scheduled(`    let { email, comments } = lookup Customer(123)\n        select email, entityid`))).toContain("MYNT1065 'comments' is not in this projection (Customer[email, entityid])");
    expect(first(scheduled(`${info}    let { email, email: again } = info`))).toBe("MYNT1065 'email' is bound twice (first at column 11); bind each field once");
    expect(first(scheduled(`${info}    let { email: x, comments: x } = info`))).toContain("MYNT1017 'x' is already declared in this scope");
    expect(first(scheduled(`    let email = "x"\n${info}    let { email } = info`))).toBe("MYNT1017 'email' is already declared in this scope as a local (line 2); bind the field under another name, 'email: other'");
    expect(first(scheduled(`${info}    let { emial } = info`))).toContain("Did you mean 'email'?");
  });

  it("only a projection destructures: a single-field lookup is a scalar, and records, references, and rows are refused with the fix", () => {
    expect(first(scheduled(`    let { email } = lookup Customer(123)\n        select email`))).toBe(
      "MYNT1065 'let { email } = ...' binds the fields of a projection, but a lookup of one field is that field's value (string), not a projection. Write 'let email = lookup Customer(...)'",
    );
    expect(first(scheduled(`    let c = load Customer(123)\n    let { email } = c`))).toBe("MYNT1065 'let { email } = ...' binds the fields of a projection, and 'c' is a Customer. Project the fields first: 'let { email } = c[email]'");
    expect(first(scheduled(`    let { email } = Customer(123)`))).toContain("is a Ref<Customer>. Project the fields first");
    expect(first(scheduled(`    let { a } = "x"`))).toBe("MYNT1065 'let { a } = ...' binds the fields of a projection, and '\"x\"' is a string value, which has no fields to bind");
    expect(first(scheduled(`    for row in search SalesOrder group by entity select entity, total = sum(amount) {\n        let { total } = row\n    }`))).toContain("Read its result fields directly, like 'row.total'");
    expect(first(scheduled(`    let { email, ...rest } = Customer(1)[email, comments]`))).toContain("MYNT0001");
    expect(first(scheduled(`    let { entity: { email } } = x`))).toContain("MYNT0001");
  });

  it("destructured names are local symbols: hover, references, rename, and tokens; an aliased source is the schema field", () => {
    const source = scheduled(`    let info = Customer(1)[email, comments]\n    let { email, comments: note } = info\n    log.debug(email)\n    log.debug(note)`);
    expect(hover(source.replace("comments: note }", "comments: no§te }"))).toBe("```mynt\nnote: string\n```\n\nlocal · string · bound from the projection's `comments`");
    expect(hover(source.replace("comments: note }", "comm§ents: note }"))).toContain("Customer.comments: string");
    expect(hover(source.replace("log.debug(email)", "log.debug(em§ail)"))).toContain("email: string");
    const note = at(source.replace("log.debug(note)", "log.debug(no§te)"));
    const local = symbolAt(note.doc, note.offset)!;
    expect(local.kind).toBe("local");
    expect(referencesOf(note.doc, local).map((r) => [r.span.start.line, r.isDeclaration])).toEqual([[3, true], [5, false]]);
    expect(renameRefusal(local)).toBeUndefined();
    expect(local.kind === "local" ? renameConflict(note.doc, local.local, "email") : "").toContain("'email' is already declared");
    // The source side of an alias is the schema field, a different symbol: its references include the projection's own [comments].
    const field = at(source.replace("comments: note", "comm§ents: note"));
    const fieldSymbol = symbolAt(field.doc, field.offset)!;
    expect(fieldSymbol.kind).toBe("field");
    expect(referencesOf(field.doc, fieldSymbol).map((r) => r.span.start.line)).toEqual([2, 3]);
    expect(renameRefusal(fieldSymbol)).toContain("NetSuite field");
    expect(tokens(source).filter((t) => /^(email|comments|note):/.test(t))).toEqual([
      "email:property",
      "comments:property",
      "email:variable+declaration",
      "comments:property",
      "note:variable+declaration",
      "email:variable",
      "note:variable",
    ]);
  });

  it("completion inside a pattern offers the projection's fields, minus those listed", () => {
    const info = `    let info = Customer(1)[email, comments]\n`;
    expect(labels(scheduled(`${info}    let { § } = info`))).toEqual(["email", "comments"]);
    expect(labels(scheduled(`${info}    let { email, § } = info`))).toEqual(["comments"]);
    expect(labels(scheduled(`${info}    let { comments: note, § } = info`))).toEqual(["email"]);
    expect(labels(scheduled(`    let { email, § } = lookup Customer(1)[email, comments]`))).toEqual(["comments"]);
  });

  it("cut-short patterns and lookups are reported and leave the next statement intact", () => {
    for (const cut of [`    let {`, `    let { email,`, `    let { email, comments }`, `    let info = lookup Customer(123)\n        select`, `    let info = lookup Customer(123)[`]) {
      const result = compileRefs(scheduled(`${cut}\n    log.debug("next")\n    let after = 1`));
      expect(result.diagnostics[0]!.code).toBe("MYNT0001");
      expect(result.unit && result.unit.kind === "Scheduled" ? result.unit.entryPoint.body.some((s) => s.kind === "ExpressionStatement") : false).toBe(true);
    }
  });
});

describe("contextual words", () => {
  it("lookup, select, load, Search, File, and saved stay names wherever they are not operations or types", () => {
    expect(messages(scheduled(`    let lookup = "x"\n    let select = lookup\n    let saved = select\n    log.debug(saved)`))).toEqual([]);
    expect(messages(`fn lookup(value: string): string {\n    return value\n}\nscheduled {\n    log.debug(lookup("x"))\n}\n`)).toEqual([]);
    expect(messages(scheduled(`    let Search = "x"\n    let File = Search\n    log.debug(File)`))).toEqual([]);
    // `load` is a builtin name, shadowed by a local as before.
    expect(messages(scheduled(`    let load = "x"\n    log.debug(load)`))).toEqual([]);
  });
});

describe("the example", () => {
  it("compiles against the reference schema and runs: one lookup per reference, none for the loaded record", () => {
    const result = compileRefs(EXAMPLE);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatchSnapshot();
    const netsuite = run(result.output!);
    expect(netsuite.search.lookupCalls.map((c) => c.columns)).toEqual([["email", "comments"], ["entityid", "email"]]);
    expect(netsuite.record.loadCalls.map((c) => c.id)).toEqual(["123"]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "hello", "A", "hello"]);
  });
});
