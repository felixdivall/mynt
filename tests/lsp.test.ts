import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { completionsAt } from "../src/lsp/completion.js";
import { completionSite } from "../src/lsp/context.js";
import { hoverAt } from "../src/lsp/hover.js";
import { definitionAt, documentOutline } from "../src/lsp/navigation.js";
import { LineIndex } from "../src/lsp/position.js";
import { ProjectRegistry } from "../src/lsp/project.js";
import { SailLanguageService } from "../src/lsp/service.js";
import { serializeSnapshot } from "../src/netsuite/schema/snapshot.js";
import { analyze, expressionAt, expressionEndingAt, nodeAt, resolveNameAt, typeAt } from "../src/semantic/query.js";
import { typeName } from "../src/semantic/types.js";
import { DocumentSchemaProvider } from "../src/schema/provider.js";
import { fixtureSchema, schema } from "./helpers.js";

/** Analyze `source` with a `§` marking the cursor; returns the document and the cursor offset. */
function at(source: string) {
  const offset = source.indexOf("§");
  if (offset < 0) throw new Error("no cursor");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { doc: analyze(text, "test.sail", schema), offset, text };
}

function labels(source: string): string[] {
  const { doc, offset } = at(source);
  return completionsAt(doc, offset).map((i) => i.label);
}

function context(source: string): string {
  const { doc, offset, text } = at(source);
  const site = completionSite(text, offset, (name) => resolveNameAt(doc, name, offset));
  return site.context.kind + (site.prefix ? `:${site.prefix}` : "");
}

function hover(source: string): string | undefined {
  const { doc, offset } = at(source);
  return hoverAt(doc, offset)?.contents;
}

const UE = `beforeSubmit edit (customer: Customer) {\n`;

describe("lsp: positions", () => {
  it("maps offsets to line/character and back across lines", () => {
    const lines = new LineIndex("ab\ncd\n\nef");
    expect(lines.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(lines.positionAt(2)).toEqual({ line: 0, character: 2 });
    expect(lines.positionAt(3)).toEqual({ line: 1, character: 0 });
    expect(lines.positionAt(6)).toEqual({ line: 2, character: 0 });
    expect(lines.positionAt(8)).toEqual({ line: 3, character: 1 });
    expect(lines.positionAt(99)).toEqual({ line: 3, character: 2 });
    for (const offset of [0, 1, 2, 3, 5, 6, 7, 9]) expect(lines.offsetAt(lines.positionAt(offset))).toBe(offset);
    expect(lines.offsetAt({ line: 0, character: 50 })).toBe(2);
    expect(lines.offsetAt({ line: 9, character: 0 })).toBe(9);
  });

  it("counts UTF-16 code units, which is what both the compiler and LSP use", () => {
    const text = `scheduled {\n    log.debug("😀 héllo")\n    customer.x = "y"\n}\n`;
    const lines = new LineIndex(text);
    const doc = analyze(text, "t.sail", schema);
    const unknown = doc.diagnostics.find((d) => d.code === "SAIL1010")!;
    expect(lines.rangeOf(unknown.span)).toEqual({ start: { line: 2, character: 4 }, end: { line: 2, character: 12 } });
    // The emoji is two code units; a span after it on the same line reflects that.
    const emojiLine = text.split("\n")[1]!;
    expect(emojiLine.indexOf("héllo")).toBe(emojiLine.indexOf("😀") + 3);
    expect(lines.positionAt(text.indexOf("héllo"))).toEqual({ line: 1, character: 18 });
    expect(lines.offsetAt({ line: 1, character: 18 })).toBe(text.indexOf("héllo"));
  });

  it("keeps a carriage return on its line", () => {
    const lines = new LineIndex("a\r\nb");
    expect(lines.positionAt(3)).toEqual({ line: 1, character: 0 });
    expect(lines.positionAt(1)).toEqual({ line: 0, character: 1 });
  });
});

describe("lsp: diagnostics", () => {
  function service(text: string) {
    const svc = new SailLanguageService(new ProjectRegistry(() => schema));
    svc.open("untitled:t.sail", text, 1);
    return svc;
  }

  it("maps an unknown field to its exact range with the compiler's message", () => {
    const svc = service(`${UE}    customer.emial = "x"\n}\n`);
    expect(svc.diagnostics("untitled:t.sail")).toEqual([
      {
        range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } },
        severity: 1,
        code: "SAIL1004",
        source: "sail",
        message: "Customer has no field 'emial'. Did you mean 'email'?",
      },
    ]);
  });

  it("maps an unknown record type, a syntax error, and a warning", () => {
    const record = service(`scheduled {\n    let customer = load Custmer("123")\n}\n`).diagnostics("untitled:t.sail");
    expect(record[0]).toMatchObject({ code: "SAIL1001", severity: 1, range: { start: { line: 1, character: 24 }, end: { line: 1, character: 31 } } });
    expect(record[0]!.message).toContain("Did you mean 'Customer'?");

    const syntax = service(`scheduled {\n    save\n}\n`).diagnostics("untitled:t.sail");
    expect(syntax[0]).toMatchObject({ code: "SAIL0001", severity: 1, range: { start: { line: 1, character: 8 }, end: { line: 2, character: 0 } } });
    expect(syntax[0]!.message).toBe("Expected a record to save after 'save', found end of statement");

    const warning = service(`scheduled {\n    let c = load Customer("1")\n    c.comments = "x"\n}\n`).diagnostics("untitled:t.sail");
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({ code: "SAIL2001", severity: 2, range: { start: { line: 2, character: 4 } } });
  });

  it("re-analyzes on change and clears on close", () => {
    const svc = service(`${UE}    customer.emial = "x"\n}\n`);
    expect(svc.diagnostics("untitled:t.sail")).toHaveLength(1);
    svc.change("untitled:t.sail", `${UE}    customer.email = "x"\n}\n`, 2);
    expect(svc.diagnostics("untitled:t.sail")).toEqual([]);
    svc.close("untitled:t.sail");
    expect(() => svc.diagnostics("untitled:t.sail")).toThrow("is not open");
  });
});

describe("lsp: completion context", () => {
  it("classifies the cursor without the syntax tree", () => {
    expect(context(`§`)).toBe("topLevel");
    expect(context(`befo§`)).toBe("topLevel:befo");
    expect(context(`scheduled {\n}\n§`)).toBe("topLevel");
    expect(context(`beforeSubmit §`)).toBe("eventName");
    expect(context(`beforeSubmit create | ed§`)).toBe("eventName:ed");
    expect(context(`beforeSubmit edit (customer: Cus§`)).toBe("recordType:Cus");
    expect(context(`beforeSubmit edit (cust§`)).toBe("none:cust");
    expect(context(`${UE}    §`)).toBe("statement");
    expect(context(`${UE}    le§`)).toBe("statement:le");
    expect(context(`${UE}    customer.§`)).toBe("member");
    expect(context(`${UE}    customer.com§`)).toBe("member:com");
    expect(context(`${UE}    log.§`)).toBe("member");
    expect(context(`${UE}    let c = load Cus§`)).toBe("recordType:Cus");
    expect(context(`${UE}    let c = load §`)).toBe("recordType");
    expect(context(`${UE}    let c = §`)).toBe("expression");
    expect(context(`${UE}    let §`)).toBe("none");
    expect(context(`${UE}    if §`)).toBe("expression");
    expect(context(`${UE}    if customer.email == §`)).toBe("expression");
    expect(context(`${UE}    if (§`)).toBe("expression");
    expect(context(`${UE}    save §`)).toBe("expression");
    expect(context(`${UE}    log.debug("hel§lo")`)).toBe("none");
    expect(context(`${UE}    if a == "" {\n    } §`)).toBe("statement");
  });
});

describe("lsp: completion", () => {
  it("offers entry points at top level, as snippets", () => {
    const { doc, offset } = at(`§`);
    const items = completionsAt(doc, offset);
    expect(items.map((i) => i.label)).toEqual(["beforeSubmit", "afterSubmit", "scheduled", "fn"]);
    expect(items[0]!.insertText).toBe("beforeSubmit ${1:edit} (${2:record}: ${3:Customer}) {\n\t$0\n}");
  });

  it("offers event names after a hook", () => {
    expect(labels(`beforeSubmit §`)).toContain("edit");
    expect(labels(`afterSubmit create | §`)).toContain("xedit");
  });

  it("offers record types from the schema for a parameter type and after load", () => {
    expect(labels(`beforeSubmit edit (customer: Cus§)`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`scheduled {\n    let customer = load Cus§("123")\n}\n`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    const { doc, offset } = at(`scheduled {\n    let c = load §`);
    expect(completionsAt(doc, offset)[0]).toMatchObject({ label: "Customer", detail: "record", documentation: "NetSuite record `customer` · `record.Type.CUSTOMER`" });
  });

  it("offers the context record's fields with type and writability", () => {
    const { doc, offset } = at(`${UE}    customer.§\n}\n`);
    const items = completionsAt(doc, offset);
    expect(items.map((i) => i.label)).toEqual(["comments", "email", "entityid"]);
    expect(items[0]).toMatchObject({ label: "comments", detail: "Text · writable", documentation: "Comments\nNetSuite field `comments`" });
    expect(items[2]).toMatchObject({ label: "entityid", detail: "Text · read-only" });
  });

  it("offers a loaded record's fields through the same path, and never another record's", () => {
    expect(labels(`scheduled {\n    let customer = load Customer("123")\n    customer.§\n}\n`)).toEqual(["comments", "email", "entityid"]);
    expect(labels(`scheduled {\n    let order = load SalesOrder("1")\n    order.§\n}\n`)).toEqual(["memo", "total", "item"]);
    expect(labels(`${UE}    customer.§\n}\n`)).not.toContain("memo");
  });

  it("offers namespace members with signatures", () => {
    const { doc, offset } = at(`${UE}    log.§\n}\n`);
    const items = completionsAt(doc, offset);
    expect(items.map((i) => i.label)).toEqual(["debug", "audit", "error", "emergency"]);
    expect(items[0]!.detail).toBe("log.debug(message: Text) -> Void");
  });

  it("offers statements, locals, and built-ins at a statement position", () => {
    const items = labels(`scheduled {\n    let c = load Customer("1")\n    §\n}\n`);
    expect(items).toEqual(["let", "if", "save", "delete", "for", "add", "remove", "return", "c", "log", "load", "create", "copy", "transform"]);
  });

  it("offers locals, built-ins, and Bool literals in expression position, respecting scope", () => {
    expect(labels(`${UE}    let c = load Customer("1")\n    if c.email == §`)).toEqual(["customer", "c", "log", "load", "create", "copy", "transform", "true", "false"]);
    expect(labels(`scheduled {\n    if true {\n        let inner = "x"\n    }\n    log.debug(§)\n}\n`)).toEqual(["log", "load", "create", "copy", "transform", "true", "false"]);
    const { doc, offset } = at(`${UE}    save §`);
    expect(completionsAt(doc, offset)[0]).toMatchObject({ label: "customer", detail: "Customer (context record, saved by NetSuite)" });
  });

  it("shows a custom field from a pulled-style schema", () => {
    const custom = structuredClone(fixtureSchema);
    custom.records.customer!.fields.custentity_tier = { type: "Text", label: "Tier", writable: true, custom: true };
    const doc = analyze(`${UE}    customer.\n}\n`, "t.sail", new DocumentSchemaProvider(custom));
    const items = completionsAt(doc, `${UE}    customer.`.length);
    expect(items.find((i) => i.label === "custentity_tier")).toMatchObject({ detail: "Text · writable · custom" });
  });

  it("stays useful on incomplete and malformed source", () => {
    expect(labels(`beforeSubmit edit (customer: Cus§`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`${UE}    customer.§`)).toEqual(["comments", "email", "entityid"]);
    expect(labels(`${UE}    customer.§\n    save customer\n}\n`)).toEqual(["comments", "email", "entityid"]);
    expect(labels(`scheduled {\n    let c = load Cus§`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    // A broken statement earlier in the block does not take the parameter out of scope.
    expect(labels(`${UE}    customer.comments = \n    customer. = "x"\n    customer.§\n}\n`)).toEqual(["comments", "email", "entityid"]);
    // A let whose initializer failed is not in scope, but everything else is.
    expect(labels(`scheduled {\n    let a = load Customer("1")\n    let b = load Nope("2")\n    §\n}\n`)).toEqual(["let", "if", "save", "delete", "for", "add", "remove", "return", "a", "log", "load", "create", "copy", "transform"]);
  });

  it("offers nothing for member chains that are not records, inside strings, or after unknown names", () => {
    expect(labels(`${UE}    customer.email.§`)).toEqual([]);
    expect(labels(`${UE}    nope.§`)).toEqual([]);
    expect(labels(`${UE}    log.debug("a§")`)).toEqual([]);
  });
});

describe("lsp: hover", () => {
  it("describes record types in parameter and load position", () => {
    expect(hover(`beforeSubmit edit (customer: Cust§omer) {\n}\n`)).toBe("```sail\nrecord Customer\n```\n\nNetSuite record `customer` · `record.Type.CUSTOMER`");
    expect(hover(`scheduled {\n    let o = load Sales§Order("1")\n}\n`)).toContain("record SalesOrder");
  });

  it("describes fields with label, writability, and NetSuite id", () => {
    expect(hover(`${UE}    customer.comm§ents = "x"\n}\n`)).toBe("```sail\nCustomer.comments: Text\n```\n\nComments · Text · writable · NetSuite field `comments`");
    expect(hover(`scheduled {\n    let o = load SalesOrder("1")\n    log.debug(o.tot§al)\n}\n`)).toContain("SalesOrder.total: Number\n```\n\nTotal · Number · read-only");
    expect(hover(`scheduled {\n    log.debug(load Customer("1").em§ail)\n}\n`)).toContain("Customer.email: Text");
  });

  it("describes locals with their type and origin, at declaration and use", () => {
    expect(hover(`${UE}    save cust§omer\n}\n`)).toBe("```sail\ncustomer: Customer\n```\n\nparameter · Customer (context record, saved by NetSuite)");
    expect(hover(`beforeSubmit edit (cust§omer: Customer) {\n}\n`)).toContain("parameter · Customer (context record, saved by NetSuite)");
    expect(hover(`scheduled {\n    let c = load Customer("1")\n    save c§\n}\n`)).toBe("```sail\nc: Customer\n```\n\nlocal · Customer (owned record, persists only through save)");
    expect(hover(`scheduled {\n    let miss§ing = true\n}\n`)).toBe("```sail\nmissing: Bool\n```\n\nlocal · Bool");
  });

  it("describes built-ins with signatures", () => {
    expect(hover(`scheduled {\n    let c = lo§ad Customer("1")\n}\n`)).toBe("```sail\nload T(id: Text) -> T\n```\n\nLoads the existing record with the given internal id. · NetSuite module `N/record`");
    expect(hover(`scheduled {\n    log.deb§ug("x")\n}\n`)).toBe("```sail\nlog.debug(message: Text) -> Void\n```\n\nWrites a debug entry to the NetSuite execution log. · NetSuite module `N/log`");
    expect(hover(`scheduled {\n    lo§g.debug("x")\n}\n`)).toContain("namespace log");
    expect(hover(`beforeSubmit ed§it (c: Customer) {\n}\n`)).toContain("event edit");
  });

  it("returns nothing on literals, whitespace, and unknown names", () => {
    expect(hover(`scheduled {\n    log.debug("he§llo")\n}\n`)).toBeUndefined();
    expect(hover(`scheduled {\n  §  log.debug("x")\n}\n`)).toBeUndefined();
    expect(hover(`scheduled {\n    save no§pe\n}\n`)).toBeUndefined();
  });
});

describe("lsp: navigation", () => {
  it("goes from a local use to its declaration", () => {
    const { doc, offset, text } = at(`scheduled {\n    let c = load Customer("1")\n    save c§\n}\n`);
    expect(definitionAt(doc, offset)?.start.offset).toBe(text.indexOf("c = load"));
    const param = at(`${UE}    save cust§omer\n}\n`);
    expect(definitionAt(param.doc, param.offset)?.start.offset).toBe(param.text.indexOf("customer"));
    const field = at(`${UE}    customer.comm§ents = "x"\n}\n`);
    expect(definitionAt(field.doc, field.offset)).toBeUndefined();
  });

  it("outlines entry points and their locals", () => {
    const { doc } = at(`${UE}    let a = "x"\n    if true {\n        let b = "y"\n    }\n}\nafterSubmit (c: Customer) {\n}§\n`);
    expect(documentOutline(doc).map((s) => `${s.name} ${s.detail} [${s.children.map((c) => c.name).join(",")}]`)).toEqual([
      "beforeSubmit edit (customer: Customer) [a,b]",
      "afterSubmit (c: Customer) []",
    ]);
  });
});

describe("lsp: project and schema resolution", () => {
  function project(options: { config?: string; snapshot?: boolean }) {
    const root = mkdtempSync(join(tmpdir(), "sail-lsp-"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    if (options.config !== undefined) writeFileSync(join(root, "sail.json"), options.config);
    if (options.snapshot) {
      const custom = structuredClone(fixtureSchema);
      custom.source = { kind: "account", platform: "netsuite", account: "1", pulledAt: "2026-10-07T00:00:00.000Z" };
      custom.records.customer!.fields.custentity_tier = { type: "Text", label: "Tier", writable: true, custom: true };
      mkdirSync(join(root, ".sail", "schema"), { recursive: true });
      writeFileSync(join(root, ".sail", "schema", "sandbox.json"), serializeSnapshot(custom));
    }
    const uri = pathToFileURL(join(root, "src", "deep", "x.sail")).toString();
    return { root, uri, registry: new ProjectRegistry(() => schema) };
  }

  it("loads the project's snapshot for a file below the root", () => {
    const { uri, registry } = project({ config: `{ "account": "sandbox" }`, snapshot: true });
    const svc = new SailLanguageService(registry);
    svc.open(uri, `${UE}    customer.custentity_tier = "gold"\n}\n`, 1);
    expect(svc.schemaDescription(uri)).toBe("account 'sandbox'");
    expect(svc.diagnostics(uri)).toEqual([]);
  });

  it("falls back to the built-in sample with a warning when the snapshot is missing", () => {
    const { uri, registry } = project({ config: `{ "account": "sandbox" }` });
    const svc = new SailLanguageService(registry);
    svc.open(uri, `${UE}    customer.custentity_tier = "gold"\n}\n`, 1);
    const diagnostics = svc.diagnostics(uri);
    expect(diagnostics[0]).toMatchObject({
      severity: 2,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      message: "No schema snapshot found for account 'sandbox'. Run `sail schema pull sandbox`. Checking against the built-in sample schema until then.",
    });
    expect(diagnostics[1]).toMatchObject({ code: "SAIL1004" });
  });

  it("uses the built-in sample without a project, survives a broken sail.json, and reloads a changed snapshot", () => {
    const none = project({});
    expect(none.registry.schemaForUri(none.uri).description).toBe("built-in sample schema");
    expect(none.registry.schemaForUri("untitled:x.sail").description).toBe("built-in sample schema");

    const broken = project({ config: "{ not json" });
    expect(broken.registry.schemaForUri(broken.uri)).toMatchObject({ description: "built-in sample schema" });

    const { root, uri, registry } = project({ config: `{ "account": "sandbox" }` });
    expect(registry.schemaForUri(uri).problem).toContain("No schema snapshot");
    mkdirSync(join(root, ".sail", "schema"), { recursive: true });
    const snapshot = structuredClone(fixtureSchema);
    writeFileSync(join(root, ".sail", "schema", "sandbox.json"), serializeSnapshot(snapshot));
    expect(registry.schemaForUri(uri).description).toBe("account 'sandbox'");
  });
});

describe("lsp: semantic expression queries", () => {
  function typeAtCursor(source: string): string | undefined {
    const { doc, offset } = at(source);
    const type = typeAt(doc, offset);
    return type === undefined ? undefined : typeName(type);
  }

  it("answers typeAt from the bound model", () => {
    expect(typeAtCursor(`${UE}    save cust§omer\n}\n`)).toBe("Customer");
    expect(typeAtCursor(`${UE}    log.debug(customer.comm§ents)\n}\n`)).toBe("Text");
    expect(typeAtCursor(`${UE}    if customer.email =§= "" { }\n}\n`)).toBe("Bool");
    expect(typeAtCursor(`${UE}    if customer.email == "" |§| customer.comments == "" { }\n}\n`)).toBe("Bool");
    expect(typeAtCursor(`${UE}    if !§(customer.email == "") { }\n}\n`)).toBe("Bool");
    expect(typeAtCursor(`scheduled {\n    let c = lo§ad Customer("1")\n}\n`)).toBe("Customer");
    expect(typeAtCursor(`scheduled {\n    let c = create Cust§omer\n}\n`)).toBe("Customer");
    expect(typeAtCursor(`scheduled {\n    let c = load Customer("§1")\n}\n`)).toBe("Text");
    expect(typeAtCursor(`scheduled {\n  §  log.debug("x")\n}\n`)).toBeUndefined();
  });

  it("finds expressions and references, including inside statements that failed", () => {
    const { doc, offset } = at(`${UE}    load Customer("1").§\n}\n`);
    expect(expressionAt(doc, offset - 2)?.kind).toBe("BuiltinCall");
    expect(expressionEndingAt(doc, offset - 1)).toMatchObject({ kind: "BuiltinCall", type: { record: { name: "Customer" } } });
    const customer = at(`${UE}    customer.§\n}\n`);
    expect(expressionEndingAt(customer.doc, customer.offset - 1)).toMatchObject({ kind: "LocalReference" });
    const callee = at(`${UE}    log.de§bug("x")\n}\n`);
    expect(nodeAt(callee.doc, callee.offset)?.kind).toBe("BuiltinReference");
    const type = at(`${UE}    let c = load Cust§omer("1")\n}\n`);
    expect(nodeAt(type.doc, type.offset)?.kind).toBe("RecordTypeReference");
  });
});

describe("lsp: create and arbitrary receivers", () => {
  it("offers record types after create, complete or not", () => {
    expect(labels(`scheduled {\n    let c = create §\n}\n`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`scheduled {\n    let c = create Cus§`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(context(`scheduled {\n    let c = create Cus§`)).toBe("recordType:Cus");
  });

  it("completes fields of a created local through the ordinary member path", () => {
    expect(labels(`scheduled {\n    let customer = create Customer\n    customer.§\n}\n`)).toEqual(["comments", "email", "entityid"]);
    expect(labels(`scheduled {\n    let entry = create SailLog\n    entry.§\n}\n`)).toEqual(["name", "custrecord_sail_message", "custrecord_sail_done"]);
  });

  it("completes fields of any record-valued expression", () => {
    expect(labels(`scheduled {\n    load Customer("123").§\n}\n`)).toEqual(["comments", "email", "entityid"]);
    expect(labels(`scheduled {\n    create SalesOrder.§\n}\n`)).toEqual(["memo", "total", "item"]);
    expect(labels(`scheduled {\n    log.debug(load Customer("1").§)\n}\n`)).toEqual(["comments", "email", "entityid"]);
    expect(labels(`scheduled {\n    load Customer("1").email.§\n}\n`)).toEqual([]);
  });

  it("hovers created locals and the create built-in", () => {
    expect(hover(`scheduled {\n    let c = create Customer\n    save c§\n}\n`)).toBe("```sail\nc: Customer\n```\n\nlocal · Customer (owned record, persists only through save)");
    expect(hover(`scheduled {\n    let c = cre§ate Customer\n}\n`)).toBe("```sail\ncreate T -> T\n```\n\nCreates a new, unsaved record of type T. · NetSuite module `N/record`");
    expect(hover(`scheduled {\n    let c = create Cust§omer\n}\n`)).toContain("record Customer");
  });

  it("hovers write targets and reads identically, from the bound model", () => {
    const read = hover(`${UE}    log.debug(customer.comm§ents)\n}\n`);
    const write = hover(`${UE}    customer.comm§ents = "x"\n}\n`);
    expect(read).toBe("```sail\nCustomer.comments: Text\n```\n\nComments · Text · writable · NetSuite field `comments`");
    expect(write).toBe(read);
    expect(hover(`${UE}    custo§mer.comments = "x"\n}\n`)).toContain("customer: Customer");
    expect(hover(`${UE}    customer.comments = "x"§\n}\n`)).toBeUndefined();
  });
});

describe("lsp: copy, transform, and delete", () => {
  it("completes record types after copy, after transform, and after to", () => {
    expect(labels(`scheduled {\n    let c = copy Cus§`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`scheduled {\n    let i = transform Sales§`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`scheduled {\n    let i = transform SalesOrder("123") to Inv§`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(context(`scheduled {\n    let i = transform SalesOrder("123") to §`)).toBe("recordType");
  });

  it("completes target-type fields on a transformed local and source-type fields on a copy", () => {
    expect(labels(`scheduled {\n    let inv = transform SalesOrder("123") to Invoice\n    inv.§\n}\n`)).toEqual(["memo", "tranid", "total", "item"]);
    expect(labels(`scheduled {\n    let dup = copy Customer("1")\n    dup.§\n}\n`)).toEqual(["comments", "email", "entityid"]);
    expect(labels(`scheduled {\n    transform SalesOrder("1") to Invoice.§\n}\n`)).toEqual(["memo", "tranid", "total", "item"]);
  });

  it("hovers the operations with their signatures and offers delete as a statement", () => {
    expect(hover(`scheduled {\n    let d = co§py Customer("1")\n    save d\n}\n`)).toBe("```sail\ncopy T(id: Text) -> T\n```\n\nCreates a new, unsaved copy of the record with the given internal id. · NetSuite module `N/record`");
    expect(hover(`scheduled {\n    let i = trans§form SalesOrder("1") to Invoice\n    save i\n}\n`)).toContain("```sail\ntransform T(id: Text) to U -> U\n```");
    expect(hover(`scheduled {\n    let i = transform SalesOrder("1") to Inv§oice\n    save i\n}\n`)).toContain("record Invoice");
    expect(labels(`scheduled {\n    let c = load Customer("1")\n    §\n}\n`)).toContain("delete");
    expect(labels(`scheduled {\n    let c = load Customer("1")\n    delete §\n}\n`)).toContain("c");
  });
});

describe("lsp: query and loops", () => {
  it("completes record types after query, fields after where, and fields plus id on a loop variable", () => {
    expect(labels(`scheduled {\n    let c = query Cus§`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`scheduled {\n    let c = query Customer where ema§`)).toEqual(["comments", "email", "entityid", "true", "false"]);
    expect(context(`scheduled {\n    let c = query Customer\n        where §`)).toBe("queryField");
    expect(labels(`scheduled {\n    let c = query Customer where email != "" && §`)).toContain("comments");
    expect(labels(`scheduled {\n    let n = "x"\n    let c = query Customer where email == §`)).toContain("n");
    expect(labels(`scheduled {\n    let c = query Customer\n    for row in c {\n        row.§\n    }\n}\n`)).toEqual(["id", "comments", "email", "entityid"]);
    expect(labels(`scheduled {\n    for row in query SalesOrder {\n        log.debug(row.§)\n    }\n}\n`)).toEqual(["id", "memo", "total"]);
    expect(labels(`scheduled {\n    let c = query Customer\n    for row in §`)).toContain("c");
  });

  it("hovers a loop variable as a read-only query result, and its id", () => {
    expect(hover(`scheduled {\n    for row in query Customer {\n        log.debug(ro§w.email)\n    }\n}\n`)).toBe("```sail\nrow: Customer\n```\n\nloop variable · Customer (query result, read-only)");
    expect(hover(`scheduled {\n    for row in query Customer {\n        log.debug(row.i§d)\n    }\n}\n`)).toBe("```sail\nCustomer.id: Text\n```\n\ninternal id of the record · use it to `load` the record");
    expect(hover(`scheduled {\n    let c = query Customer where ema§il != ""\n}\n`)).toContain("Customer.email: Text");
    expect(hover(`scheduled {\n    let c = query Cust§omer\n}\n`)).toContain("record Customer");
  });

  it("stays useful while a query or loop is being typed", () => {
    expect(labels(`scheduled {\n    let c = query Cus§\n}\n`)).toEqual(["Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`scheduled {\n    let c = query Customer where ema§\n}\n`)).toContain("email");
    expect(labels(`scheduled {\n    let c = query Customer\n    for row in c {\n        row.§`)).toEqual(["id", "comments", "email", "entityid"]);
  });
});

describe("lsp: sublists", () => {
  const ORDER = `scheduled {\n    let order = load SalesOrder("1")\n`;

  it("completes body fields and sublists on a record, only fields on a query row, and only line fields on a line", () => {
    const { doc, offset } = at(`${ORDER}    order.§\n}\n`);
    const items = completionsAt(doc, offset);
    expect(items.map((i) => i.label)).toEqual(["memo", "total", "item"]);
    expect(items[2]).toMatchObject({ label: "item", detail: "sublist", documentation: "Items · sublist of SalesOrder · iterate with 'for line in x.item'" });
    expect(labels(`${ORDER}    order.it§\n}\n`)).toContain("item");
    expect(labels(`scheduled {\n    for row in query SalesOrder {\n        row.§\n    }\n}\n`)).toEqual(["id", "memo", "total"]);
    const line = at(`${ORDER}    for line in order.item {\n        line.§\n    }\n}\n`);
    const lineItems = completionsAt(line.doc, line.offset);
    expect(lineItems.map((i) => i.label)).toEqual(["item", "quantity", "rate", "amount", "description"]);
    expect(lineItems[3]).toMatchObject({ label: "amount", detail: "Number · read-only", documentation: "Amount · SalesOrder.item\nNetSuite field `amount`" });
    expect(labels(`beforeSubmit edit (order: SalesOrder) {\n    for line in order.item {\n        line.§`)).toContain("quantity");
  });

  it("hovers the sublist, the line, and a line field", () => {
    expect(hover(`${ORDER}    for line in order.it§em { }\n}\n`)).toBe(
      "```sail\nitem: sublist of SalesOrder\n```\n\nItems · 5 fields · iterate with `for line in x.item`; lines persist when the SalesOrder is saved",
    );
    expect(hover(`${ORDER}    for line in order.item {\n        log.debug(li§ne.description)\n    }\n}\n`)).toBe(
      "```sail\nline: Line<SalesOrder.item>\n```\n\nloop variable · line of SalesOrder.item (persisted with the parent SalesOrder)",
    );
    expect(hover(`${ORDER}    for line in order.item {\n        line.quan§tity = 1\n    }\n    save order\n}\n`)).toBe(
      "```sail\nSalesOrder.item.quantity: Number\n```\n\nQuantity · Number · writable · NetSuite field `quantity`",
    );
    expect(hover(`${ORDER}    for line in order.item {\n        log.debug(line.descr§iption)\n    }\n}\n`)).toContain("SalesOrder.item.description: Text");
  });

  it("answers typeAt for sublists and lines", () => {
    const { doc, text } = at(`${ORDER}    for line in order.item {\n        if line.quantity < 1 {\n            line.quantity = 1\n        }\n    }\n    save order§\n}\n`);
    expect(typeName(typeAt(doc, text.indexOf("order.item") + 7)!)).toBe("Sublist<SalesOrder.item>");
    expect(typeName(typeAt(doc, text.indexOf("line.quantity") + 1)!)).toBe("Line<SalesOrder.item>");
    expect(typeName(typeAt(doc, text.indexOf("line.quantity") + 7)!)).toBe("Number");
    expect(typeName(typeAt(doc, text.indexOf("line.quantity <"))!)).toBe("Line<SalesOrder.item>");
  });
});

describe("lsp: add and remove", () => {
  const ORDER = `scheduled {\n    let order = load SalesOrder("1")\n`;

  it("completes sublists after add order. and initializer fields inside the block", () => {
    expect(labels(`${ORDER}    add order.§`)).toEqual(["memo", "total", "item"]);
    expect(labels(`${ORDER}    add order.it§`)).toContain("item");
    const { doc, offset } = at(`${ORDER}    add order.item {\n        quant§\n    }\n    save order\n}\n`);
    const items = completionsAt(doc, offset);
    expect(items.map((i) => i.label)).toEqual(["item", "quantity", "rate", "amount", "description"]);
    expect(items[3]).toMatchObject({ label: "amount", detail: "Number · read-only" });
    expect(labels(`${ORDER}    add order.item {\n        item = "1"\n        §`)).toEqual(["item", "quantity", "rate", "amount", "description"]);
    expect(labels(`${ORDER}    add order.item {\n        quant§`)).toContain("quantity");
    expect(labels(`${ORDER}    add order.item {\n        quantity = §`)).toContain("order");
    expect(labels(`${ORDER}    for line in order.item {\n        remove li§`)).toContain("line");
    expect(labels(`${ORDER}    §`)).toEqual(expect.arrayContaining(["add", "remove"]));
  });

  it("hovers initializer fields with the sublist owner, and the sublist in an add", () => {
    expect(hover(`${ORDER}    add order.item {\n        quan§tity = 2\n    }\n    save order\n}\n`)).toBe(
      "```sail\nSalesOrder.item.quantity: Number\n```\n\nQuantity · Number · writable · NetSuite field `quantity`",
    );
    expect(hover(`${ORDER}    add order.it§em {\n        quantity = 2\n    }\n    save order\n}\n`)).toContain("item: sublist of SalesOrder");
    expect(hover(`${ORDER}    for line in order.item {\n        remove li§ne\n    }\n    save order\n}\n`)).toContain("line: Line<SalesOrder.item>");
  });
});

describe("lsp: functions", () => {
  const FN = `fn setMemo(order: SalesOrder, memo: Text) {\n    order.memo = memo\n}\n`;

  it("completes function names, parameter and return types, and the fn snippet", () => {
    expect(labels(`${FN}scheduled {\n    let order = load SalesOrder("1")\n    §\n}\n`)).toContain("setMemo");
    expect(labels(`${FN}scheduled {\n    let order = load SalesOrder("1")\n    if §`)).toContain("setMemo");
    expect(labels(`§`)).toContain("fn");
    expect(labels(`fn f(order: §`)).toEqual(["Text", "Number", "Bool", "Customer", "SalesOrder", "SailLog", "Invoice"]);
    expect(labels(`fn f(order: SalesOrder) -> §`)).toEqual(["Text", "Number", "Bool"]);
    expect(labels(`${FN.replace("    order.memo = memo\n", "    order.§\n")}scheduled { }\n`)).toEqual(["memo", "total", "item"]);
    expect(labels(`${FN.replace("    order.memo = memo\n", "    return §\n")}scheduled { }\n`)).toContain("memo");
  });

  it("hovers calls, declarations, and parameters", () => {
    expect(hover(`${FN}scheduled {\n    let order = load SalesOrder("1")\n    set§Memo(order, "x")\n    save order\n}\n`)).toBe(
      "```sail\nfn setMemo(order: SalesOrder, memo: Text)\n```\n\nrecord parameters: order · what the function does to them is checked at each call",
    );
    expect(hover(`fn set§Memo(order: SalesOrder, memo: Text) {\n    order.memo = memo\n}\nscheduled { }\n`)).toContain("fn setMemo(order: SalesOrder, memo: Text)");
    expect(hover(`fn f(or§der: SalesOrder) {\n    order.memo = "x"\n}\nscheduled { }\n`)).toBe("```sail\norder: SalesOrder\n```\n\nparameter · SalesOrder (record parameter; what this function does to it is checked at each call)");
    expect(hover(`fn f(order: SalesOrder) {\n    or§der.memo = "x"\n}\nscheduled { }\n`)).toContain("record parameter");
    expect(hover(`fn isBig(n: Number) -> Bool {\n    return n > 1\n}\nscheduled {\n    if is§Big(2) { }\n}\n`)).toBe("```sail\nfn isBig(n: Number) -> Bool\n```");
  });
});
