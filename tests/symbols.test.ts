import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { LineIndex } from "../src/lsp/position.js";
import { ProjectRegistry } from "../src/lsp/project.js";
import { SailLanguageService } from "../src/lsp/service.js";
import { DocumentSchemaProvider } from "../src/schema/provider.js";
import { analyze } from "../src/semantic/query.js";
import { declarationOf, referencesOf, renameConflict, symbolAt, symbolName, type SemanticSymbol } from "../src/semantic/symbols.js";
import { fixtureSchema, schema } from "./helpers.js";
import { FakeNetSuite, scheduledContext } from "./harness/fake-netsuite.js";

/** `§` marks the cursor; returns the document, the cursor offset, and the text. */
function at(source: string) {
  const offset = source.indexOf("§");
  if (offset < 0) throw new Error("no cursor");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { doc: analyze(text, "test.sail", schema), offset, text };
}

/** The source text of each reference, with `[declaration]` marked, for readable assertions. */
function refs(source: string): string[] {
  const { doc, offset, text } = at(source);
  const symbol = symbolAt(doc, offset);
  if (!symbol) return ["<no symbol>"];
  return referencesOf(doc, symbol).map((r) => {
    const slice = text.slice(r.span.start.offset, r.span.end.offset);
    return `${r.span.start.line - 1}:${r.span.start.column - 1} ${slice}${r.isDeclaration ? " [declaration]" : ""}`;
  });
}

function symbol(source: string): SemanticSymbol | undefined {
  const { doc, offset } = at(source);
  return symbolAt(doc, offset);
}

const UE = `beforeSubmit edit (customer: Customer) {\n`;

describe("semantic symbols", () => {
  it("identifies a parameter at its declaration and at every use as one symbol", () => {
    const text = `beforeSubmit edit (customer: Customer) {\n    log.debug(customer.email)\n    customer.comments = "x"\n    save customer\n}\n`;
    const doc = analyze(text, "t.sail", schema);
    const declaration = symbolAt(doc, text.indexOf("(customer:") + 1);
    const read = symbolAt(doc, text.indexOf("debug(customer") + 8);
    const write = symbolAt(doc, text.indexOf("\n    customer.comments") + 7);
    const saved = symbolAt(doc, text.indexOf("save customer") + 5);
    expect(declaration?.kind).toBe("local");
    if (declaration?.kind !== "local" || read?.kind !== "local" || write?.kind !== "local" || saved?.kind !== "local") throw new Error();
    expect(saved.local).toBe(declaration.local);
    expect(read.local).toBe(declaration.local);
    expect(write.local).toBe(declaration.local);
    expect(declaration.local.origin).toBe("parameter");
  });

  it("identifies a let local at its declaration and uses", () => {
    const text = `scheduled {\n    let customer = load Customer("123")\n    log.debug(customer.email)\n    save customer\n}\n`;
    const doc = analyze(text, "t.sail", schema);
    const declaration = symbolAt(doc, text.indexOf("let customer") + 6);
    const use = symbolAt(doc, text.indexOf("save customer") + 6);
    if (declaration?.kind !== "local" || use?.kind !== "local") throw new Error();
    expect(use.local).toBe(declaration.local);
    expect(declarationOf(declaration)).toEqual(declaration.local.declaredAt);
    expect(symbolName(declaration)).toBe("customer");
  });

  it("keeps same-spelled locals in sibling scopes distinct", () => {
    const source = `scheduled {\n    if true {\n        let record = load Customer("1")\n        log.debug(record.email)\n    }\n    if false {\n        let record = load Customer("2")\n        log.debug(record.email)\n    }\n}\n`;
    const doc = analyze(source, "t.sail", schema);
    const first = symbolAt(doc, source.indexOf('let record = load Customer("1")') + 5);
    const second = symbolAt(doc, source.indexOf('let record = load Customer("2")') + 5);
    if (first?.kind !== "local" || second?.kind !== "local") throw new Error();
    expect(first.local).not.toBe(second.local);
    expect(refs(source.replace('let record = load Customer("1")', 'let rec§ord = load Customer("1")'))).toEqual(["2:12 record [declaration]", "3:18 record"]);
  });

  it("returns identifier-only spans and nothing for literals, keywords, or whitespace", () => {
    expect(refs(`${UE}    log.debug(cust§omer.email)\n}\n`)).toEqual(["0:19 customer [declaration]", "1:14 customer"]);
    expect(symbol(`${UE}    log.debug("cust§omer")\n}\n`)).toBeUndefined();
    expect(symbol(`${UE}    sa§ve customer\n}\n`)).toBeUndefined();
    expect(symbol(`${UE}  §  save customer\n}\n`)).toBeUndefined();
  });

  it("identifies fields by record and field object, record types, and built-ins", () => {
    const field = symbol(`${UE}    customer.comm§ents = "x"\n}\n`);
    expect(field).toMatchObject({ kind: "field", record: { name: "Customer" }, field: { id: "comments" } });
    expect(symbol(`${UE}    let o = load Sales§Order("1")\n}\n`)).toMatchObject({ kind: "recordType", record: { name: "SalesOrder" } });
    expect(symbol(`beforeSubmit edit (customer: Cust§omer) {\n}\n`)).toMatchObject({ kind: "recordType", record: { name: "Customer" } });
    expect(symbol(`${UE}    log.de§bug("x")\n}\n`)).toMatchObject({ kind: "builtin", builtin: { id: "log.debug" } });
    expect(symbol(`${UE}    lo§g.debug("x")\n}\n`)).toBeUndefined();
    expect(symbol(`${UE}    let c = cre§ate Customer\n    save c\n}\n`)).toMatchObject({ kind: "builtin", builtin: { id: "create" } });
  });
});

describe("find references", () => {
  it("parameter: declaration, reads, writes, and saves", () => {
    expect(refs(`beforeSubmit edit (cust§omer: Customer) {\n    log.debug(customer.email)\n    customer.comments = "x"\n}\n`)).toEqual([
      "0:19 customer [declaration]",
      "1:14 customer",
      "2:4 customer",
    ]);
  });

  it("local: declaration and every use, and the two locals stay distinct", () => {
    const source = `beforeSubmit edit (customer: Customer) {\n    let loaded = load Customer("123")\n    log.debug(customer.email)\n    log.debug(loaded.email)\n    save loaded\n}\n`;
    expect(refs(source.replace("let loaded", "let loa§ded"))).toEqual(["1:8 loaded [declaration]", "3:14 loaded", "4:9 loaded"]);
    expect(refs(source.replace("(customer:", "(cust§omer:"))).toEqual(["0:19 customer [declaration]", "2:14 customer"]);
  });

  it("created local", () => {
    expect(refs(`scheduled {\n    let customer = create Customer\n    customer.comments = "x"\n    save cust§omer\n}\n`)).toEqual([
      "1:8 customer [declaration]",
      "2:4 customer",
      "3:9 customer",
    ]);
  });

  it("references inside both branches resolve to the outer declaration", () => {
    expect(refs(`scheduled {\n    let §c = load Customer("1")\n    if c.email == "" {\n        c.comments = "a"\n    } else {\n        log.debug(c.email)\n    }\n    save c\n}\n`)).toEqual([
      "1:8 c [declaration]",
      "2:7 c",
      "3:8 c",
      "5:18 c",
      "7:9 c",
    ]);
  });

  it("survives an unrelated syntax error elsewhere in the body", () => {
    const source = `scheduled {\n    let customer = load Customer("1")\n    log.debug(customer.email)\n\n    totally broken syntax here\n\n    save cust§omer\n}\n`;
    const { doc } = at(source);
    expect(doc.diagnostics.map((d) => d.code)).toContain("SAIL0001");
    expect(refs(source)).toEqual(["1:8 customer [declaration]", "2:14 customer", "6:9 customer"]);
  });

  it("finds references in a statement that failed to bind", () => {
    expect(refs(`scheduled {\n    let §c = load Customer("1")\n    c.nope = c.email\n    save c\n}\n`)).toEqual([
      "1:8 c [declaration]",
      "2:4 c",
      "2:13 c",
      "3:9 c",
    ]);
  });

  it("field references are per record type, not per spelling", () => {
    const shared = structuredClone(fixtureSchema);
    shared.records.salesorder!.fields.comments = { type: "Text", label: "Comments", writable: true };
    const provider = new DocumentSchemaProvider(shared);
    const text = `scheduled {\n    let c = load Customer("1")\n    let o = load SalesOrder("2")\n    c.comments = "x"\n    o.comments = "y"\n    log.debug(c.comments)\n    log.debug(o.comments)\n    save c\n    save o\n}\n`;
    const doc = analyze(text, "t.sail", provider);
    const symbol = symbolAt(doc, text.indexOf("c.comments") + 2)!;
    expect(symbolName(symbol)).toBe("Customer.comments");
    expect(referencesOf(doc, symbol).map((r) => `${r.span.start.line}:${r.span.start.column}`)).toEqual(["4:7", "6:17"]);
  });

  it("record-type references cover parameter, load, and create", () => {
    expect(refs(`beforeSubmit edit (customer: Cust§omer) {\n    let loaded = load Customer("1")\n    let created = create Customer\n    let other = load SalesOrder("3")\n    save loaded\n    save created\n}\n`)).toEqual([
      "0:29 Customer",
      "1:22 Customer",
      "2:25 Customer",
    ]);
  });

  it("built-in references are per registry entry", () => {
    expect(refs(`${UE}    log.de§bug("a")\n    log.audit("b")\n    log.debug(customer.email)\n}\n`)).toEqual(["1:8 debug", "3:8 debug"]);
  });
});

describe("rename validation", () => {
  function conflict(source: string, newName: string): string | undefined {
    const { doc, offset } = at(source);
    const symbol = symbolAt(doc, offset);
    if (symbol?.kind !== "local") throw new Error("not a local");
    return renameConflict(doc, symbol.local, newName);
  }
  const LOCAL = `scheduled {\n    let cust§omer = load Customer("1")\n    let other = load Customer("2")\n    log.debug(customer.email)\n    save customer\n    save other\n}\n`;

  it("accepts a fresh valid name, including names the emitter must rename in JavaScript", () => {
    expect(conflict(LOCAL, "client")).toBeUndefined();
    expect(conflict(LOCAL, "record")).toBeUndefined();
    expect(conflict(LOCAL, "context")).toBeUndefined();
    expect(conflict(LOCAL, "_x1")).toBeUndefined();
  });

  it("rejects reserved words, literals, and invalid spellings", () => {
    expect(conflict(LOCAL, "if")).toBe("'if' is reserved and cannot name a local");
    expect(conflict(LOCAL, "let")).toBe("'let' is reserved and cannot name a local");
    expect(conflict(LOCAL, "save")).toContain("reserved");
    expect(conflict(LOCAL, "scheduled")).toContain("reserved");
    expect(conflict(LOCAL, "true")).toContain("reserved");
    expect(conflict(LOCAL, "false")).toContain("reserved");
    expect(conflict(LOCAL, "invalid-name")).toBe("'invalid-name' is not a valid identifier");
    expect(conflict(LOCAL, "1abc")).toContain("not a valid identifier");
    expect(conflict(LOCAL, "")).toContain("not a valid identifier");
    expect(conflict(LOCAL, "customer")).toBe("'customer' is already the name");
  });

  it("rejects a same-scope collision in either direction", () => {
    expect(conflict(LOCAL, "other")).toBe("'other' is already declared in this scope as a local (line 3)");
    expect(conflict(LOCAL.replace("cust§omer", "customer").replace("let other", "let oth§er"), "customer")).toBe(
      "'customer' is already declared in this scope as a local (line 2)",
    );
  });

  it("rejects colliding with the parameter or an enclosing local, allows a disjoint sibling", () => {
    expect(conflict(`${UE}    let loa§ded = load Customer("1")\n    save loaded\n}\n`, "customer")).toBe(
      "'customer' is already declared in this scope as the entry point parameter (line 1)",
    );
    expect(conflict(`scheduled {\n    let outer = load Customer("1")\n    if true {\n        let inn§er = load Customer("2")\n        save inner\n    }\n    save outer\n}\n`, "outer")).toContain(
      "'outer' is already declared in this scope",
    );
    expect(conflict(`scheduled {\n    let out§er = load Customer("1")\n    if true {\n        let inner = load Customer("2")\n        save inner\n    }\n    save outer\n}\n`, "inner")).toContain(
      "'inner' is already declared in this scope",
    );
    expect(conflict(`scheduled {\n    if true {\n        let §a = load Customer("1")\n        save a\n    }\n    if false {\n        let b = load Customer("2")\n        save b\n    }\n}\n`, "b")).toBeUndefined();
  });

  it("rejects a name that would capture a built-in used in the scope", () => {
    expect(conflict(LOCAL, "log")).toBe("'log' is used as a built-in in this scope (line 4); the rename would make it mean the local instead");
    expect(conflict(LOCAL, "load")).toContain("'load' is used as a built-in in this scope (line 3)");
    expect(conflict(`scheduled {\n    let §c = create Customer\n    save c\n}\n`, "log")).toBeUndefined();
  });
});

describe("rename and references through the language service", () => {
  function service(text: string) {
    const svc = new SailLanguageService(new ProjectRegistry(() => schema));
    const uri = "untitled:t.sail";
    svc.open(uri, text, 1);
    return { svc, uri, lines: new LineIndex(text), text };
  }
  function applyEdits(text: string, edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]): string {
    const lines = new LineIndex(text);
    const sorted = [...edits].sort((a, b) => lines.offsetAt(b.range.start) - lines.offsetAt(a.range.start));
    let out = text;
    for (const edit of sorted) out = out.slice(0, lines.offsetAt(edit.range.start)) + edit.newText + out.slice(lines.offsetAt(edit.range.end));
    return out;
  }

  it("renames a local everywhere, in source order, without overlapping edits", () => {
    const { svc, uri, text, lines } = service(`scheduled {\n    let customer = load Customer("123")\n    log.debug(customer.email)\n    save customer\n}\n`);
    const position = lines.positionAt(text.indexOf("save customer") + 5);
    const result = svc.rename(uri, position, "client");
    if ("error" in result) throw new Error(result.error);
    const edits = result.ok.changes![uri]!;
    expect(edits.map((e) => `${e.range.start.line}:${e.range.start.character}-${e.range.end.character}`)).toEqual(["1:8-16", "2:14-22", "3:9-17"]);
    const renamed = applyEdits(text, edits);
    expect(renamed).toBe(`scheduled {\n    let client = load Customer("123")\n    log.debug(client.email)\n    save client\n}\n`);
    expect(compile(renamed, { file: "t.sail", schema }).diagnostics).toEqual([]);
  });

  it("renames a parameter and an owned local, and keeps a field named like the local untouched", () => {
    const { svc, uri, text, lines } = service(`beforeSubmit edit (email: Customer) {\n    let created = create Customer\n    created.email = email.email\n    save created\n}\n`);
    const parameter = svc.rename(uri, lines.positionAt(text.indexOf("(email") + 1), "customer");
    if ("error" in parameter) throw new Error(parameter.error);
    expect(applyEdits(text, parameter.ok.changes![uri]!)).toBe(`beforeSubmit edit (customer: Customer) {\n    let created = create Customer\n    created.email = customer.email\n    save created\n}\n`);
    const owned = svc.rename(uri, lines.positionAt(text.indexOf("save created") + 6), "entry");
    if ("error" in owned) throw new Error(owned.error);
    expect(applyEdits(text, owned.ok.changes![uri]!)).toContain(`let entry = create Customer\n    entry.email = email.email\n    save entry`);
  });

  it("renaming to a name the emitter must hygienically rename still compiles and runs", () => {
    const { svc, uri, text, lines } = service(`scheduled {\n    let customer = create Customer\n    customer.comments = "x"\n    save customer\n}\n`);
    const result = svc.rename(uri, lines.positionAt(text.indexOf("let customer") + 4), "record");
    if ("error" in result) throw new Error(result.error);
    const renamed = applyEdits(text, result.ok.changes![uri]!);
    const compiled = compile(renamed, { file: "t.sail", schema });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.output).toContain('define(["N/record"], (record$) => {');
    expect(compiled.output).toContain("const record = record$.create({");
    const netsuite = new FakeNetSuite();
    netsuite.load(compiled.output!).execute!(scheduledContext());
    expect(netsuite.record.persisted("customer", "1000")).toEqual({ comments: "x" });
  });

  it("prepareRename accepts locals and refuses everything else with a reason", () => {
    const { svc, uri, text, lines } = service(`${UE}    let loaded = load Customer("1")\n    log.debug(loaded.email)\n    save loaded\n}\n`);
    const local = svc.prepareRename(uri, lines.positionAt(text.indexOf("loaded.email") + 2));
    expect(local).toEqual({ ok: { range: { start: { line: 2, character: 14 }, end: { line: 2, character: 20 } }, placeholder: "loaded" } });
    const parameter = svc.prepareRename(uri, lines.positionAt(text.indexOf("(customer") + 1));
    expect(parameter).toEqual({ ok: { range: { start: { line: 0, character: 19 }, end: { line: 0, character: 27 } }, placeholder: "customer" } });
    expect(svc.prepareRename(uri, lines.positionAt(text.indexOf("Customer)")))).toEqual({ error: "'Customer' is a record type; its name comes from the schema and cannot be renamed here" });
    expect(svc.prepareRename(uri, lines.positionAt(text.indexOf(".email") + 2))).toEqual({ error: "'email' is a NetSuite field of Customer; its name comes from the schema and cannot be renamed here" });
    expect(svc.prepareRename(uri, lines.positionAt(text.indexOf("debug")))).toEqual({ error: "'log.debug' is a built-in and cannot be renamed" });
    expect(svc.prepareRename(uri, lines.positionAt(text.indexOf("save")))).toEqual({ error: "Nothing to rename here" });
    expect(svc.prepareRename(uri, lines.positionAt(text.indexOf('"1"') + 1))).toEqual({ error: "Nothing to rename here" });
  });

  it("rename reports conflicts instead of editing", () => {
    const { svc, uri, text, lines } = service(`scheduled {\n    let customer = load Customer("1")\n    let other = load Customer("2")\n    save customer\n    save other\n}\n`);
    expect(svc.rename(uri, lines.positionAt(text.indexOf("let other") + 4), "customer")).toEqual({ error: "'customer' is already declared in this scope as a local (line 2)" });
    expect(svc.rename(uri, lines.positionAt(text.indexOf("let other") + 4), "if")).toEqual({ error: "'if' is reserved and cannot name a local" });
    expect(svc.rename(uri, lines.positionAt(text.indexOf("Customer(")), "x")).toEqual({ error: "'Customer' is a record type; its name comes from the schema and cannot be renamed here" });
  });

  it("references honor includeDeclaration and definition uses the same identity", () => {
    const { svc, uri, text, lines } = service(`scheduled {\n    let customer = load Customer("123")\n    log.debug(customer.email)\n    save customer\n}\n`);
    const use = lines.positionAt(text.indexOf("save customer") + 13);
    expect(svc.references(uri, use, true).map((l) => l.range.start)).toEqual([{ line: 1, character: 8 }, { line: 2, character: 14 }, { line: 3, character: 9 }]);
    expect(svc.references(uri, use, false).map((l) => l.range.start)).toEqual([{ line: 2, character: 14 }, { line: 3, character: 9 }]);
    expect(svc.definition(uri, use)).toEqual({ uri, range: { start: { line: 1, character: 8 }, end: { line: 1, character: 16 } } });
    expect(svc.references(uri, lines.positionAt(text.indexOf('"123"') + 2), true)).toEqual([]);
  });

  it("refuses rename when the symbol itself did not bind", () => {
    const { svc, uri, text, lines } = service(`scheduled {\n    let c = load Nope("1")\n    save c\n}\n`);
    expect(svc.prepareRename(uri, lines.positionAt(text.indexOf("save c") + 5))).toEqual({ error: "Nothing to rename here" });
  });
});

describe("references for the new operations", () => {
  it("counts copy, transform source, and transform target as record-type references", () => {
    expect(refs(`scheduled {\n    let a = copy Cust§omer("1")\n    let b = transform Customer("2") to Invoice\n    let c = transform SalesOrder("3") to Customer\n    save a\n    save b\n    save c\n}\n`)).toEqual([
      "1:17 Customer",
      "2:22 Customer",
      "3:41 Customer",
    ]);
    expect(refs(`scheduled {\n    let b = transform SalesOrder("2") to Inv§oice\n    let i = load Invoice("4")\n    save b\n}\n`)).toEqual(["1:41 Invoice", "2:17 Invoice"]);
  });

  it("counts delete targets as local references and transform as a built-in reference", () => {
    expect(refs(`scheduled {\n    let §c = load Customer("1")\n    delete c\n}\n`)).toEqual(["1:8 c [declaration]", "2:11 c"]);
    expect(refs(`scheduled {\n    let a = trans§form SalesOrder("1") to Invoice\n    let b = transform SalesOrder("2") to Invoice\n    save a\n    save b\n}\n`)).toEqual(["1:12 transform", "2:12 transform"]);
  });
});

describe("loop variables and query references", () => {
  it("renames and finds references to a loop variable, scoped to its body", () => {
    const text = `scheduled {\n    for customer in query Customer {\n        log.debug(customer.email)\n        let loaded = load Customer(customer.id)\n        save loaded\n    }\n}\n`;
    const doc = analyze(text, "t.sail", schema);
    const symbol = symbolAt(doc, text.indexOf("customer.email") + 2);
    expect(symbol).toMatchObject({ kind: "local", local: { name: "customer", origin: "loop" } });
    expect(referencesOf(doc, symbol!).map((r) => `${r.span.start.line - 1}:${r.span.start.column - 1}${r.isDeclaration ? " [declaration]" : ""}`)).toEqual(["1:8 [declaration]", "2:18", "3:35"]);
    if (symbol?.kind !== "local") throw new Error();
    expect(renameConflict(doc, symbol.local, "row")).toBeUndefined();
    expect(renameConflict(doc, symbol.local, "loaded")).toContain("already declared in this scope");
    expect(renameConflict(doc, symbol.local, "query")).toContain("reserved");
  });

  it("query record types and where-clause fields are references to the schema symbols", () => {
    expect(refs(`scheduled {\n    let c = query Cust§omer where email != ""\n    let l = load Customer("1")\n    let m = create Customer\n    save m\n}\n`)).toEqual(["1:18 Customer", "2:17 Customer", "3:19 Customer"]);
    expect(refs(`${UE}    let c = query Customer where ema§il != ""\n    log.debug(customer.email)\n}\n`)).toEqual(["1:33 email", "2:23 email"]);
  });
});

describe("sublist symbols", () => {
  const ORDER = `scheduled {\n    let order = load SalesOrder("1")\n`;

  it("renames and finds references to a line local, and refuses the sublist and its fields", () => {
    const text = `${ORDER}    for line in order.item {\n        if line.quantity < 1 {\n            line.quantity = 1\n        }\n    }\n    save order\n}\n`;
    const doc = analyze(text, "t.sail", schema);
    const line = symbolAt(doc, text.indexOf("line.quantity") + 1)!;
    expect(line).toMatchObject({ kind: "local", local: { name: "line", origin: "loop" } });
    expect(referencesOf(doc, line).map((r) => `${r.span.start.line - 1}:${r.span.start.column - 1}${r.isDeclaration ? " [declaration]" : ""}`)).toEqual(["2:8 [declaration]", "3:11", "4:12"]);
    if (line.kind !== "local") throw new Error();
    expect(renameConflict(doc, line.local, "row")).toBeUndefined();
    expect(renameConflict(doc, line.local, "order")).toContain("already declared in this scope");

    const sublist = symbolAt(doc, text.indexOf("order.item") + 7)!;
    expect(sublist).toMatchObject({ kind: "sublist", record: { name: "SalesOrder" }, sublist: { id: "item" } });
    expect(symbolName(sublist)).toBe("SalesOrder.item");
    const field = symbolAt(doc, text.indexOf("line.quantity = 1") + 6)!;
    expect(symbolName(field)).toBe("SalesOrder.item.quantity");
    expect(referencesOf(doc, field).map((r) => `${r.span.start.line - 1}:${r.span.start.column - 1}`)).toEqual(["3:16", "4:17"]);
  });

  it("keeps a sublist field distinct from a body field or another sublist's field of the same name", () => {
    const text = `${ORDER}    let inv = load Invoice("2")\n    for line in order.item {\n        log.debug(line.item)\n    }\n    for line in inv.item {\n        log.debug(line.item)\n    }\n}\n`;
    const doc = analyze(text, "t.sail", schema);
    const orderItem = symbolAt(doc, text.indexOf("order.item") + 7)!;
    const invoiceItem = symbolAt(doc, text.indexOf("inv.item") + 5)!;
    expect(symbolName(orderItem)).toBe("SalesOrder.item");
    expect(symbolName(invoiceItem)).toBe("Invoice.item");
    expect(referencesOf(doc, orderItem)).toHaveLength(1);
    const lineItemField = symbolAt(doc, text.indexOf("line.item") + 6)!;
    expect(symbolName(lineItemField)).toBe("SalesOrder.item.item");
    expect(referencesOf(doc, lineItemField)).toHaveLength(1);
  });
});

describe("add-block symbols", () => {
  it("initializer fields and sublists in add blocks share schema identity with loops, and locals in values rename", () => {
    const text = `scheduled {\n    let qty = 2\n    let order = load SalesOrder("1")\n    add order.item {\n        quantity = qty\n    }\n    for line in order.item {\n        line.quantity = qty\n    }\n    save order\n}\n`;
    const doc = analyze(text, "t.sail", schema);
    const field = symbolAt(doc, text.indexOf("quantity = qty") + 2)!;
    expect(symbolName(field)).toBe("SalesOrder.item.quantity");
    expect(referencesOf(doc, field).map((r) => `${r.span.start.line - 1}:${r.span.start.column - 1}`)).toEqual(["4:8", "7:13"]);
    const sublist = symbolAt(doc, text.indexOf("add order.item") + 11)!;
    expect(symbolName(sublist)).toBe("SalesOrder.item");
    expect(referencesOf(doc, sublist)).toHaveLength(2);
    const qty = symbolAt(doc, text.indexOf("= qty") + 3)!;
    if (qty.kind !== "local") throw new Error();
    expect(referencesOf(doc, qty)).toHaveLength(3);
    expect(renameConflict(doc, qty.local, "count")).toBeUndefined();
    expect(renameConflict(doc, qty.local, "remove")).toContain("reserved");
    const refusal = symbolAt(doc, text.indexOf("quantity = qty") + 2)!;
    expect(refusal.kind).toBe("field");
  });
});

describe("function symbols", () => {
  const text = `fn setMemo(order: SalesOrder, memo: Text) {\n    order.memo = memo\n}\nscheduled {\n    let order = load SalesOrder("1")\n    setMemo(order, "x")\n    setMemo(order, "y")\n    save order\n}\n`;

  it("finds references to a function from its declaration and calls, and goes to the declaration", () => {
    const doc = analyze(text, "t.sail", schema);
    const fromCall = symbolAt(doc, text.indexOf('setMemo(order, "y")') + 2)!;
    const fromDeclaration = symbolAt(doc, text.indexOf("fn setMemo") + 4)!;
    expect(fromCall).toMatchObject({ kind: "function", function: { name: "setMemo" } });
    expect(fromCall.kind === "function" && fromDeclaration.kind === "function" && fromCall.function === fromDeclaration.function).toBe(true);
    expect(referencesOf(doc, fromCall).map((r) => `${r.span.start.line - 1}:${r.span.start.column - 1}${r.isDeclaration ? " [declaration]" : ""}`)).toEqual([
      "0:3 [declaration]",
      "5:4",
      "6:4",
    ]);
    expect(declarationOf(fromCall)?.start.offset).toBe(3);
  });

  it("parameters are ordinary locals: references, scope, and rename", () => {
    const doc = analyze(text, "t.sail", schema);
    const parameter = symbolAt(doc, text.indexOf("(order: SalesOrder") + 2)!;
    expect(parameter).toMatchObject({ kind: "local", local: { name: "order", origin: "parameter" } });
    expect(referencesOf(doc, parameter).map((r) => `${r.span.start.line - 1}:${r.span.start.column - 1}`)).toEqual(["0:11", "1:4"]);
    const callerOrder = symbolAt(doc, text.indexOf("save order") + 6)!;
    expect(callerOrder.kind === "local" && parameter.kind === "local" && callerOrder.local !== parameter.local).toBe(true);
    if (parameter.kind !== "local") throw new Error();
    expect(renameConflict(doc, parameter.local, "record")).toBeUndefined();
    expect(renameConflict(doc, parameter.local, "memo")).toContain("already declared in this scope");
    expect(renameConflict(doc, parameter.local, "setMemo")).toBeUndefined();
  });

  it("renames a function at every site and refuses collisions and reserved words", () => {
    const svc = new SailLanguageService(new ProjectRegistry(() => schema));
    const uri = "untitled:t.sail";
    svc.open(uri, text, 1);
    const lines = new LineIndex(text);
    const result = svc.rename(uri, lines.positionAt(text.indexOf('setMemo(order, "x")') + 3), "stamp");
    if ("error" in result) throw new Error(result.error);
    expect(result.ok.changes![uri]!.map((e) => `${e.range.start.line}:${e.range.start.character}`)).toEqual(["0:3", "5:4", "6:4"]);
    expect(svc.prepareRename(uri, lines.positionAt(text.indexOf("fn setMemo") + 5))).toEqual({ ok: { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 10 } }, placeholder: "setMemo" } });
    expect(svc.rename(uri, lines.positionAt(text.indexOf("fn setMemo") + 5), "load")).toEqual({ error: "'load' is already the name of a built-in or record type" });
    expect(svc.rename(uri, lines.positionAt(text.indexOf("fn setMemo") + 5), "return")).toEqual({ error: "'return' is reserved and cannot name a function" });
    expect(svc.rename(uri, lines.positionAt(text.indexOf("fn setMemo") + 5), "order")).toEqual({ error: "'order' is a local (line 1), which would shadow the function wherever it is in scope" });
    const two = `fn a() { }\nfn b() { }\nscheduled {\n    a()\n}\n`;
    svc.open(uri, two, 2);
    expect(svc.rename(uri, { line: 3, character: 4 }, "b")).toEqual({ error: "'b' is already a function (line 2)" });
  });
});
