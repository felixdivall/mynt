import { parse as parseJs } from "acorn";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDiagnostic } from "../src/diagnostics.js";
import { compileSail } from "./helpers.js";
import { FakeRecord, loadSuiteScriptModule, userEventContext } from "./harness/fake-netsuite.js";

const VALID = readFileSync(new URL("../examples/customer.sail", import.meta.url), "utf8");
const INVALID = readFileSync(new URL("../examples/customer-invalid.sail", import.meta.url), "utf8");

describe("end to end: Sail -> SuiteScript -> fake NetSuite", () => {
  it("compiles the valid example without diagnostics", () => {
    const result = compileSail(VALID, "examples/customer.sail");
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toBeDefined();
  });

  it("produces a resolved ScriptUnit", () => {
    const { unit } = compileSail(VALID);
    expect(unit?.kind).toBe("UserEvent");
    expect(unit?.record.name).toBe("Customer");
    expect(unit?.record.id).toBe("customer");
    expect(unit?.entryPoints).toHaveLength(1);
    const entry = unit!.entryPoints[0]!;
    expect(entry.hook).toBe("beforeSubmit");
    expect(entry.events).toEqual(["create", "edit"]);
    expect(entry.parameter.name).toBe("customer");
    expect(entry.parameter.type).toMatchObject({ kind: "Record", record: { name: "Customer" } });
    expect(entry.body).toHaveLength(1);
    const write = entry.body[0]!;
    expect(write.kind).toBe("FieldWrite");
    expect(write.field.id).toBe("comments");
    expect(write.field.type).toBe("Text");
    expect(write.value).toMatchObject({ kind: "StringLiteral", value: "Managed by Sail" });
    expect(write.span.start).toEqual({ offset: 54, line: 2, column: 5 });
  });

  it("generates JavaScript that acorn can parse as a script", () => {
    const { output } = compileSail(VALID);
    expect(() => parseJs(output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
  });

  it("matches the expected generated SuiteScript", () => {
    const { output } = compileSail(VALID, "examples/customer.sail");
    expect(output).toMatchSnapshot();
  });

  it("executes beforeSubmit on create and sets the comments field", () => {
    const { output } = compileSail(VALID);
    const entryPoints = loadSuiteScriptModule(output!);
    expect(Object.keys(entryPoints)).toEqual(["beforeSubmit"]);

    const customer = new FakeRecord("customer");
    entryPoints.beforeSubmit!(userEventContext("create", customer));

    expect(customer.setValueCalls).toEqual([{ fieldId: "comments", value: "Managed by Sail" }]);
    expect(customer.getValue({ fieldId: "comments" })).toBe("Managed by Sail");
  });

  it("executes beforeSubmit on edit as well", () => {
    const { output } = compileSail(VALID);
    const customer = new FakeRecord("customer");
    loadSuiteScriptModule(output!).beforeSubmit!(userEventContext("edit", customer));
    expect(customer.setValueCalls).toHaveLength(1);
  });

  it("does nothing on events outside the filter", () => {
    const { output } = compileSail(VALID);
    const customer = new FakeRecord("customer");
    loadSuiteScriptModule(output!).beforeSubmit!(userEventContext("delete", customer));
    expect(customer.setValueCalls).toEqual([]);
  });

  it("rejects the invalid example with a located diagnostic", () => {
    const result = compileSail(INVALID, "src/customer.sail");
    expect(result.output).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);

    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic.code).toBe("SAIL1004");
    expect(diagnostic.span.start).toMatchObject({ line: 2, column: 14 });

    expect(formatDiagnostic(diagnostic, INVALID)).toBe(
      [
        "error SAIL1004: Customer has no field 'notAField'",
        "",
        "  src/customer.sail:2:14",
        "",
        '  2 |     customer.notAField = "Nope"',
        "    |              ^^^^^^^^^",
      ].join("\n"),
    );
  });
});

import { FakeNetSuite, scheduledContext } from "./harness/fake-netsuite.js";

const SCHEDULED = readFileSync(new URL("../examples/scheduled.sail", import.meta.url), "utf8");
const LOGGED = readFileSync(new URL("../examples/customer-logged.sail", import.meta.url), "utf8");

describe("end to end: scheduled script", () => {
  it("compiles, parses, and declares the scheduled script type with N/log", () => {
    const result = compileSail(SCHEDULED, "examples/scheduled.sail");
    expect(result.diagnostics).toEqual([]);
    const output = result.output!;
    expect(() => parseJs(output, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(output).toContain("@NScriptType ScheduledScript");
    expect(output).toContain('define(["N/log"], (log) => {');
    expect(output).toMatchSnapshot();
  });

  it("executes and logs through the fake N/log module", () => {
    const { output } = compileSail(SCHEDULED);
    const netsuite = new FakeNetSuite();
    const entryPoints = netsuite.load(output!);
    expect(Object.keys(entryPoints)).toEqual(["execute"]);

    entryPoints.execute!(scheduledContext());

    expect(netsuite.log.calls).toEqual([{ level: "debug", title: "execute", details: "Hello from Sail" }]);
  });

  it("fails to load if N/log is not provided, proving the dependency is real", () => {
    const { output } = compileSail(SCHEDULED);
    expect(() => loadSuiteScriptModule(output!, {})).toThrow("Fake NetSuite has no module 'N/log'");
  });
});

describe("end to end: user event with logging", () => {
  it("logs and mutates the record, and infers N/log", () => {
    const result = compileSail(LOGGED, "examples/customer-logged.sail");
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain('define(["N/log"], (log) => {');
    expect(result.output).toMatchSnapshot();

    const netsuite = new FakeNetSuite();
    const customer = new FakeRecord("customer");
    netsuite.load(result.output!).beforeSubmit!(userEventContext("create", customer));

    expect(netsuite.log.calls).toEqual([{ level: "audit", title: "beforeSubmit", details: "Customer create" }]);
    expect(customer.setValueCalls).toEqual([{ fieldId: "comments", value: "Managed by Sail" }]);
  });
});

const LOAD_CUSTOMER = readFileSync(new URL("../examples/load-customer.sail", import.meta.url), "utf8");

describe("end to end: load returns a typed record", () => {
  it("compiles the load example to the expected SuiteScript", () => {
    const result = compileSail(LOAD_CUSTOMER, "examples/load-customer.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toContain('define(["N/log", "N/record"], (log, record) => {');
    expect(result.output).toContain("type: record.Type.CUSTOMER");
    expect(result.output).toMatchSnapshot();
  });

  it("loads Customer 123 through fake N/record and logs its email", () => {
    const { output } = compileSail(LOAD_CUSTOMER);
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "123", { email: "hello@example.com" });

    netsuite.load(output!).execute!(scheduledContext());

    expect(netsuite.record.loadCalls).toEqual([{ type: "customer", id: "123" }]);
    expect(netsuite.log.calls).toEqual([{ level: "debug", title: "execute", details: "hello@example.com" }]);
  });

  it("loads SalesOrder 456 and audits its memo", () => {
    const source = `scheduled {\n    let order = load SalesOrder("456")\n    log.audit(order.memo)\n}\n`;
    const result = compileSail(source);
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();

    const netsuite = new FakeNetSuite();
    netsuite.record.seed("salesorder", "456", { memo: "Rush order" });
    netsuite.load(result.output!).execute!(scheduledContext());

    expect(netsuite.record.loadCalls).toEqual([{ type: "salesorder", id: "456" }]);
    expect(netsuite.log.calls).toEqual([{ level: "audit", title: "execute", details: "Rush order" }]);
  });

  it("fails to load without N/record, proving the dependency is real", () => {
    const { output } = compileSail(LOAD_CUSTOMER);
    expect(() => loadSuiteScriptModule(output!, { "N/log": new FakeNetSuite().log })).toThrow(
      "Fake NetSuite has no module 'N/record'",
    );
  });

  it("renames emitter-introduced names that collide with Sail locals", () => {
    const source = `scheduled {\n    let record = load Customer("1")\n    let context = load SalesOrder("2")\n    log.debug(record.email)\n    log.debug(context.memo)\n}\n`;
    const result = compileSail(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain('define(["N/log", "N/record"], (log, record$) => {');
    expect(result.output).toContain("function execute(context$) {");
    expect(result.output).toContain("const record = record$.load({");
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();

    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "1", { email: "a@b.c" });
    netsuite.record.seed("salesorder", "2", { memo: "m" });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@b.c", "m"]);
  });
});

const SAVE_CUSTOMER = readFileSync(new URL("../examples/save-customer.sail", import.meta.url), "utf8");

describe("end to end: record lifecycle", () => {
  it("compiles the save example to the expected SuiteScript", () => {
    const result = compileSail(SAVE_CUSTOMER, "examples/save-customer.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toContain('define(["N/record"], (record) => {');
    expect(result.output).toContain("customer.save();");
    expect(result.output).toMatchSnapshot();
  });

  it("loads, mutates, and persists Customer 123", () => {
    const { output } = compileSail(SAVE_CUSTOMER);
    const netsuite = new FakeNetSuite();
    const seeded = netsuite.record.seed("customer", "123", { comments: "Old" });

    netsuite.load(output!).execute!(scheduledContext());

    expect(netsuite.record.loadCalls).toEqual([{ type: "customer", id: "123" }]);
    expect(seeded.setValueCalls).toEqual([{ fieldId: "comments", value: "Updated by Sail" }]);
    expect(seeded.saveCount).toBe(1);
    expect(netsuite.record.persisted("customer", "123")).toEqual({ comments: "Updated by Sail" });
  });

  it("loads, mutates, and persists SalesOrder 456", () => {
    const source = `scheduled {\n    let order = load SalesOrder("456")\n    order.memo = "Processed"\n    save order\n}\n`;
    const result = compileSail(source);
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();

    const netsuite = new FakeNetSuite();
    netsuite.record.seed("salesorder", "456", { memo: "New", total: 10 });
    netsuite.load(result.output!).execute!(scheduledContext());

    expect(netsuite.record.loadCalls).toEqual([{ type: "salesorder", id: "456" }]);
    expect(netsuite.record.persisted("salesorder", "456")).toEqual({ memo: "Processed", total: 10 });
  });

  it("a user event mutation persists through NetSuite, not through save", () => {
    const result = compileSail(`beforeSubmit edit (customer: Customer) {\n    customer.comments = "Changed"\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).not.toContain(".save()");

    const customer = new FakeRecord("customer");
    new FakeNetSuite().load(result.output!).beforeSubmit!(userEventContext("edit", customer));

    expect(customer.setValueCalls).toEqual([{ fieldId: "comments", value: "Changed" }]);
    expect(customer.saveCount).toBe(0);
  });

  it("an unsaved mutation compiles with a warning and does not persist", () => {
    const result = compileSail(`scheduled {\n    let customer = load Customer("123")\n    customer.comments = "Changed"\n}\n`);
    expect(result.diagnostics.map((d) => d.severity)).toEqual(["warning"]);

    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "123", { comments: "Old" });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.record.persisted("customer", "123")).toBeUndefined();
  });
});

describe("end to end: conditional logic", () => {
  const IF = readFileSync(new URL("../examples/if-customer.sail", import.meta.url), "utf8");

  it("compiles the if example to the expected SuiteScript", () => {
    const result = compileSail(IF, "examples/if-customer.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toMatchSnapshot();
  });

  it("uses strict comparison operators", () => {
    const { output } = compileSail(
      `scheduled {\n    let o = load SalesOrder("1")\n    if o.memo != "" { }\n    if o.total >= 10 { }\n}\n`,
    );
    expect(output).toContain(`}) !== ""`);
    expect(output).toContain(`}) >= 10`);
    expect(output).not.toMatch(/[^=!]==[^=]/);
  });

  it("takes the true branch when the email is empty and persists the change", () => {
    const { output } = compileSail(IF, "examples/if-customer.sail");
    const netsuite = new FakeNetSuite();
    const customer = netsuite.record.seed("customer", "123", { email: "", comments: "Old" });
    netsuite.load(output!).execute!(scheduledContext());
    expect(netsuite.record.loadCalls).toEqual([{ type: "customer", id: "123" }]);
    expect(customer.setValueCalls).toEqual([{ fieldId: "comments", value: "Missing email" }]);
    expect(customer.saveCount).toBe(1);
    expect(netsuite.record.persisted("customer", "123")).toEqual({ email: "", comments: "Missing email" });
  });

  it("skips the branch when the email is set, and saves nothing", () => {
    const { output } = compileSail(IF, "examples/if-customer.sail");
    const netsuite = new FakeNetSuite();
    const customer = netsuite.record.seed("customer", "123", { email: "hello@example.com", comments: "Old" });
    netsuite.load(output!).execute!(scheduledContext());
    expect(customer.setValueCalls).toEqual([]);
    expect(customer.saveCount).toBe(0);
    expect(netsuite.record.persisted("customer", "123")).toBeUndefined();
    expect(customer.getValue({ fieldId: "comments" })).toBe("Old");
  });

  it("runs the else branch and numeric comparisons against seeded values", () => {
    const { output, diagnostics } = compileSail(
      `scheduled {\n    let order = load SalesOrder("7")\n    if order.total > 100 {\n        order.memo = "Large"\n    } else {\n        order.memo = "Small"\n    }\n    save order\n}\n`,
    );
    expect(diagnostics).toEqual([]);
    expect(() => parseJs(output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();

    const large = new FakeNetSuite();
    large.record.seed("salesorder", "7", { total: 250, memo: "" });
    large.load(output!).execute!(scheduledContext());
    expect(large.record.persisted("salesorder", "7")).toEqual({ total: 250, memo: "Large" });

    const small = new FakeNetSuite();
    small.record.seed("salesorder", "7", { total: 99.5, memo: "" });
    small.load(output!).execute!(scheduledContext());
    expect(small.record.persisted("salesorder", "7")).toEqual({ total: 99.5, memo: "Small" });
  });

  it("a block-scoped local compiles to a block-scoped const", () => {
    const { output, diagnostics } = compileSail(
      `scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        let n = "x"\n        log.debug(n)\n    } else {\n        let n = "y"\n        log.debug(n)\n    }\n}\n`,
    );
    expect(diagnostics).toEqual([]);
    expect(() => parseJs(output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "1", { email: "set" });
    netsuite.load(output!).execute!(scheduledContext());
    expect(netsuite.log.calls).toEqual([{ level: "debug", title: "execute", details: "y" }]);
  });
});

describe("end to end: Boolean composition", () => {
  const REVIEW = readFileSync(new URL("../examples/review-customer.sail", import.meta.url), "utf8");
  const READY = readFileSync(new URL("../examples/ready-customer.sail", import.meta.url), "utf8");

  function run(source: string, file: string, values: Record<string, unknown>) {
    const result = compileSail(source, file);
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    const netsuite = new FakeNetSuite();
    const customer = netsuite.record.seed("customer", "123", values);
    netsuite.load(result.output!).execute!(scheduledContext());
    return { output: result.output!, customer, persisted: netsuite.record.persisted("customer", "123") };
  }

  it("compiles both examples to the expected SuiteScript", () => {
    expect(compileSail(REVIEW, "examples/review-customer.sail").output).toMatchSnapshot();
    expect(compileSail(READY, "examples/ready-customer.sail").output).toMatchSnapshot();
  });

  it("OR: true from the first comparison", () => {
    const { persisted } = run(REVIEW, "examples/review-customer.sail", { email: "", comments: "Fine" });
    expect(persisted).toEqual({ email: "", comments: "Needs review" });
  });

  it("OR: true from the second comparison", () => {
    const { persisted } = run(REVIEW, "examples/review-customer.sail", { email: "a@b.c", comments: "Blocked" });
    expect(persisted).toEqual({ email: "a@b.c", comments: "Needs review" });
  });

  it("OR: both false leaves the record untouched", () => {
    const { customer, persisted } = run(REVIEW, "examples/review-customer.sail", { email: "a@b.c", comments: "Fine" });
    expect(customer.setValueCalls).toEqual([]);
    expect(customer.saveCount).toBe(0);
    expect(persisted).toBeUndefined();
  });

  it("grouping: the parenthesized OR only applies when the email is set", () => {
    expect(run(READY, "examples/ready-customer.sail", { email: "a@b.c", comments: "New" }).persisted).toEqual({ email: "a@b.c", comments: "Ready" });
    expect(run(READY, "examples/ready-customer.sail", { email: "a@b.c", comments: "" }).persisted).toEqual({ email: "a@b.c", comments: "Ready" });
    expect(run(READY, "examples/ready-customer.sail", { email: "", comments: "New" }).persisted).toBeUndefined();
    expect(run(READY, "examples/ready-customer.sail", { email: "a@b.c", comments: "Old" }).persisted).toBeUndefined();
  });

  it("grouping: moving the parentheses changes the result", () => {
    const regrouped = READY.replace(
      `customer.email != "" && (customer.comments == "" || customer.comments == "New")`,
      `(customer.email != "" && customer.comments == "") || customer.comments == "New"`,
    );
    expect(regrouped).not.toBe(READY);
    // email empty + comments "New": false under the original grouping, true under this one.
    expect(run(regrouped, "regrouped.sail", { email: "", comments: "New" }).persisted).toEqual({ email: "", comments: "Ready" });
  });

  it("unary not executes natively", () => {
    const source = `scheduled {\n    let customer = load Customer("123")\n    if !(customer.email == "") {\n        customer.comments = "Has email"\n        save customer\n    }\n}\n`;
    expect(run(source, "not.sail", { email: "a@b.c", comments: "" }).persisted).toEqual({ email: "a@b.c", comments: "Has email" });
    expect(run(source, "not.sail", { email: "", comments: "" }).persisted).toBeUndefined();
  });

  it("logical operators short-circuit in the generated code", () => {
    // The right operand reads a field; with a throwing getValue, a non-short-circuit && would fail.
    const source = `scheduled {\n    let customer = load Customer("123")\n    if customer.email == "x" && customer.comments == "y" {\n        save customer\n    }\n}\n`;
    const result = compileSail(source, "short.sail");
    const netsuite = new FakeNetSuite();
    const customer = netsuite.record.seed("customer", "123", { email: "" });
    const reads: string[] = [];
    const original = customer.getValue.bind(customer);
    customer.getValue = (options) => {
      reads.push(options.fieldId);
      return original(options);
    };
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(reads).toEqual(["email"]);
  });
});

describe("end to end: create", () => {
  const CREATE = readFileSync(new URL("../examples/create-customer.sail", import.meta.url), "utf8");

  it("compiles the create example to the expected SuiteScript with N/record once", () => {
    const result = compileSail(CREATE, "examples/create-customer.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toMatchSnapshot();
    expect(result.output).toContain('define(["N/record"], (record) => {');
    expect(result.output).toContain("record.create({\n            type: record.Type.CUSTOMER\n        });");
  });

  it("creates, writes, and persists a new Customer with an assigned id", () => {
    const { output } = compileSail(CREATE, "examples/create-customer.sail");
    const netsuite = new FakeNetSuite();
    netsuite.load(output!).execute!(scheduledContext());
    expect(netsuite.record.createCalls).toEqual([{ type: "customer" }]);
    expect(netsuite.record.loadCalls).toEqual([]);
    const [created] = netsuite.record.created;
    expect(created!.setValueCalls).toEqual([{ fieldId: "comments", value: "Created by Sail" }]);
    expect(created!.saveCount).toBe(1);
    expect(created!.id).toBe("1000");
    expect(netsuite.record.persisted("customer", "1000")).toEqual({ comments: "Created by Sail" });
  });

  it("a created record that is never saved is not persisted", () => {
    const result = compileSail(`scheduled {\n    let c = create Customer\n    c.comments = "x"\n}\n`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["SAIL2001"]);
    const netsuite = new FakeNetSuite();
    netsuite.load(result.output!).execute!(scheduledContext());
    const [created] = netsuite.record.created;
    expect(created!.id).toBeUndefined();
    expect(created!.persisted).toBeUndefined();
  });

  it("creates a custom record by its script id", () => {
    const result = compileSail(`scheduled {\n    let entry = create SailLog\n    entry.custrecord_sail_message = "hello"\n    save entry\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain('record.create({\n            type: "customrecord_sail_log"\n        });');
    const netsuite = new FakeNetSuite();
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.record.persisted("customrecord_sail_log", "1000")).toEqual({ custrecord_sail_message: "hello" });
  });

  it("a user event can create and save an owned record while NetSuite saves the context record", () => {
    const result = compileSail(`afterSubmit edit (customer: Customer) {\n    let entry = create SailLog\n    entry.custrecord_sail_message = customer.email\n    save entry\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const netsuite = new FakeNetSuite();
    const customer = new FakeRecord("customer", { email: "a@b.c" }, "5");
    netsuite.load(result.output!).afterSubmit!(userEventContext("edit", customer));
    expect(customer.saveCount).toBe(0);
    expect(netsuite.record.persisted("customrecord_sail_log", "1000")).toEqual({ custrecord_sail_message: "a@b.c" });
  });
});

describe("end to end: delete, copy, transform", () => {
  function run(source: string, seed: (netsuite: FakeNetSuite) => void) {
    const result = compileSail(source, "lifecycle.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    const netsuite = new FakeNetSuite();
    seed(netsuite);
    netsuite.load(result.output!).execute!(scheduledContext());
    return { output: result.output!, netsuite };
  }

  it("deletes a loaded record by its type constant and Record.id", () => {
    const { output, netsuite } = run(`scheduled {\n    let customer = load Customer("123")\n    delete customer\n}\n`, (ns) => {
      ns.record.seed("customer", "123", { email: "a" }).save();
    });
    expect(output).toContain("record.delete({\n            type: record.Type.CUSTOMER,\n            id: customer.id\n        });");
    expect(netsuite.record.deleteCalls).toEqual([{ type: "customer", id: "123" }]);
    expect(netsuite.record.exists("customer", "123")).toBe(false);
  });

  it("deletes a created record after save through the captured id", () => {
    const { output, netsuite } = run(`scheduled {\n    let draft = create Customer\n    draft.comments = "temp"\n    save draft\n    delete draft\n}\n`, () => {});
    expect(output).toContain("let draft$id;");
    expect(output).toContain("draft$id = draft.save();");
    expect(output).toContain("id: draft$id");
    expect(netsuite.record.deleteCalls).toEqual([{ type: "customer", id: "1000" }]);
    expect(netsuite.record.exists("customer", "1000")).toBe(false);
  });

  it("the fake runtime refuses to delete an unknown id", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("9")\n    delete c\n}\n`);
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "9", {});
    const entry = netsuite.load(result.output!);
    netsuite.record.delete({ type: "customer", id: "9" });
    expect(() => entry.execute!(scheduledContext())).toThrow("no customer record with id 9");
  });

  it("copies an existing record into a new one that persists only on save", () => {
    const { output, netsuite } = run(`scheduled {\n    let dup = copy Customer("1")\n    dup.comments = "copied"\n    save dup\n}\n`, (ns) => {
      ns.record.seed("customer", "1", { email: "a@b.c", comments: "original" });
    });
    expect(output).toContain('record.copy({\n            type: record.Type.CUSTOMER,\n            id: "1"\n        });');
    expect(output.match(/N\/record/g)).toHaveLength(1);
    expect(netsuite.record.copyCalls).toEqual([{ type: "customer", id: "1" }]);
    expect(netsuite.record.persisted("customer", "1000")).toEqual({ email: "a@b.c", comments: "copied" });
    expect(netsuite.record.load({ type: "customer", id: "1" }).getValue({ fieldId: "comments" })).toBe("original");

    const unsaved = compileSail(`scheduled {\n    let dup = copy Customer("1")\n    dup.comments = "x"\n}\n`);
    expect(unsaved.diagnostics.map((d) => d.code)).toEqual(["SAIL2001"]);
    const ns = new FakeNetSuite();
    ns.record.seed("customer", "1", { email: "a@b.c" });
    ns.load(unsaved.output!).execute!(scheduledContext());
    expect(ns.record.created[0]!.id).toBeUndefined();
    expect(ns.record.exists("customer", "1000")).toBe(false);
  });

  it("transforms a sales order into an unsaved invoice of the target type", () => {
    const { output, netsuite } = run(`scheduled {\n    let inv = transform SalesOrder("55") to Invoice\n    inv.memo = "from order"\n    save inv\n}\n`, (ns) => {
      ns.record.seed("salesorder", "55", { memo: "order memo", total: 10 });
    });
    expect(output).toContain('record.transform({\n            fromType: record.Type.SALES_ORDER,\n            fromId: "55",\n            toType: record.Type.INVOICE\n        });');
    expect(netsuite.record.transformCalls).toEqual([{ fromType: "salesorder", fromId: "55", toType: "invoice" }]);
    expect(netsuite.record.persisted("invoice", "1000")).toEqual({ memo: "from order", total: 10, createdfrom: "55" });
    expect(netsuite.record.created[0]!.type).toBe("invoice");
  });

  it("copies a custom record by script id", () => {
    const { output, netsuite } = run(`scheduled {\n    let entry = copy SailLog("3")\n    save entry\n}\n`, (ns) => {
      ns.record.seed("customrecord_sail_log", "3", { name: "n" });
    });
    expect(output).toContain('type: "customrecord_sail_log"');
    expect(netsuite.record.persisted("customrecord_sail_log", "1000")).toEqual({ name: "n" });
  });
});

describe("end to end: query and iterate", () => {
  const REVIEW = readFileSync(new URL("../examples/review-customers.sail", import.meta.url), "utf8");

  function seeded() {
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "1", { email: "a@x.com", comments: "" });
    netsuite.record.seed("customer", "2", { email: "", comments: "" });
    netsuite.record.seed("customer", "3", { email: "c@x.com", comments: "Already" });
    netsuite.record.seed("customer", "4", { email: "d@x.com", comments: "" });
    return netsuite;
  }

  it("compiles the flagship example with N/query and N/record once each, and parses", () => {
    const result = compileSail(REVIEW, "examples/review-customers.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toMatchSnapshot();
    expect(result.output).toContain('define(["N/query", "N/record"], (query, record$) => {');
    expect(result.output).toContain('sail$query(query.Type.CUSTOMER, ["id"], (q) =>');
    expect(result.output).toContain("operator: query.Operator.EMPTY_NOT");
  });

  it("reviews exactly the customers that have an email and empty comments", () => {
    const { output } = compileSail(REVIEW, "examples/review-customers.sail");
    const netsuite = seeded();
    netsuite.load(output!).execute!(scheduledContext());
    expect(netsuite.query.runs).toEqual([{ type: "customer", columns: ["id"], sort: ["id"] }]);
    expect(netsuite.record.loadCalls.map((c) => c.id)).toEqual(["1", "3", "4"]);
    const comments = (id: string) => netsuite.record.load({ type: "customer", id }).getValue({ fieldId: "comments" });
    expect([comments("1"), comments("2"), comments("3"), comments("4")]).toEqual(["Reviewed by Sail", "", "Already", "Reviewed by Sail"]);
    expect(netsuite.record.persisted("customer", "1")).toEqual({ email: "a@x.com", comments: "Reviewed by Sail" });
    expect(netsuite.record.persisted("customer", "2")).toBeUndefined();
  });

  it("filters by Text, Bool, and compound conditions, reads row fields, and only fetches referenced columns", () => {
    const source = `scheduled {\n    let logs = query SailLog\n        where custrecord_sail_done && name != "skip"\n    for entry in logs {\n        log.debug(entry.custrecord_sail_message)\n    }\n    for entry in logs {\n        log.debug(entry.id)\n    }\n}\n`;
    const result = compileSail(source);
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customrecord_sail_log", "10", { name: "a", custrecord_sail_done: true, custrecord_sail_message: "first" });
    netsuite.record.seed("customrecord_sail_log", "11", { name: "skip", custrecord_sail_done: true, custrecord_sail_message: "second" });
    netsuite.record.seed("customrecord_sail_log", "12", { name: "c", custrecord_sail_done: false, custrecord_sail_message: "third" });
    netsuite.record.seed("customrecord_sail_log", "13", { name: "d", custrecord_sail_done: true, custrecord_sail_message: "fourth" });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.query.runs).toEqual([{ type: "customrecord_sail_log", columns: ["id", "custrecord_sail_message"], sort: ["id"] }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["first", "fourth", "10", "13"]);
    expect(netsuite.record.created).toEqual([]);
    expect(netsuite.record.deleteCalls).toEqual([]);
  });

  it("compares numbers, uses captured locals, and pages through large results", () => {
    const result = compileSail(`scheduled {\n    let floor = 50\n    for o in query SalesOrder where total >= floor {\n        log.debug(o.memo)\n    }\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("values: [floor]");
    const netsuite = new FakeNetSuite();
    for (let i = 1; i <= 2500; i++) netsuite.record.seed("salesorder", String(i), { memo: `o${i}`, total: i });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.log.calls).toHaveLength(2451);
    expect(netsuite.log.calls[0]!.details).toBe("o50");
  });

  it("a query with no matches runs the loop zero times", () => {
    const result = compileSail(`scheduled {\n    for c in query Customer where email == "nobody" {\n        let x = create Customer\n        save x\n    }\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const netsuite = seeded();
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.record.createCalls).toEqual([]);
  });
});

describe("end to end: sublists", () => {
  const FIX = readFileSync(new URL("../examples/fix-quantities.sail", import.meta.url), "utf8");
  const LINES = {
    item: [
      { item: "100", quantity: 2, rate: 10, amount: 20, description: "Widget" },
      { item: "200", quantity: 0, rate: 25, amount: 0, description: "Gadget" },
      { item: "300", quantity: -1, rate: 5, amount: 0, description: "Gizmo" },
    ],
  };

  it("compiles the flagship example, parses, and crosses query, load, lines, and save", () => {
    const result = compileSail(FIX, "examples/fix-quantities.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toMatchSnapshot();
    expect(result.output).toContain('define(["N/query", "N/record"], (query, record) => {');
    expect(result.output).toContain('line$index < order.getLineCount({ sublistId: "item" });');

    const netsuite = new FakeNetSuite();
    netsuite.record.seed("salesorder", "1", { memo: "a" }, LINES);
    netsuite.record.seed("salesorder", "2", { memo: "b" }, { item: [{ item: "100", quantity: 5, rate: 1, amount: 5, description: "Fine" }] });
    netsuite.record.seed("salesorder", "3", { memo: "c" });
    netsuite.load(result.output!).execute!(scheduledContext());

    expect(netsuite.record.loadCalls.map((c) => c.id)).toEqual(["1", "2", "3"]);
    const first = netsuite.record.load({ type: "salesorder", id: "1" });
    expect(first.setSublistValueCalls).toEqual([
      { sublistId: "item", fieldId: "quantity", line: 1, value: 1 },
      { sublistId: "item", fieldId: "quantity", line: 2, value: 1 },
    ]);
    expect(first.persistedLines!.item!.map((l) => l.quantity)).toEqual([2, 1, 1]);
    expect(first.saveCount).toBe(1);
    expect(netsuite.record.load({ type: "salesorder", id: "2" }).setSublistValueCalls).toEqual([]);
    expect(netsuite.record.load({ type: "salesorder", id: "3" }).saveCount).toBe(1);
  });

  it("reads line fields by index and leaves changes unsaved until the parent saves", () => {
    const result = compileSail(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        log.debug(line.description)\n        line.rate = 1\n    }\n}\n`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["SAIL2001"]);
    expect(result.output).toContain('order.getSublistValue({\n                    sublistId: "item",\n                    fieldId: "description",\n                    line: line$index\n                })');
    const netsuite = new FakeNetSuite();
    const order = netsuite.record.seed("salesorder", "1", {}, LINES);
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Widget", "Gadget", "Gizmo"]);
    expect(order.getSublistValue({ sublistId: "item", fieldId: "rate", line: 0 })).toBe(1);
    expect(order.persistedLines).toBeUndefined();
    expect(order.getLineCount({ sublistId: "item" })).toBe(3);
  });

  it("a transform target carries lines and persists line edits with the new record", () => {
    const result = compileSail(`scheduled {\n    let inv = transform SalesOrder("1") to Invoice\n    for line in inv.item {\n        line.description = "Billed"\n    }\n    save inv\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("inv.setSublistValue({");
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("salesorder", "1", {}, LINES);
    netsuite.load(result.output!).execute!(scheduledContext());
    const invoice = netsuite.record.load({ type: "invoice", id: "1000" });
    expect(invoice.persistedLines!.item!.map((l) => l.description)).toEqual(["Billed", "Billed", "Billed"]);
    expect(netsuite.record.load({ type: "salesorder", id: "1" }).getSublistValue({ sublistId: "item", fieldId: "description", line: 0 })).toBe("Widget");
  });

  it("a created record iterates zero lines", () => {
    const result = compileSail(`scheduled {\n    let fresh = create SalesOrder\n    for line in fresh.item {\n        line.rate = 5\n    }\n    save fresh\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const netsuite = new FakeNetSuite();
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.record.created[0]!.setSublistValueCalls).toEqual([]);
    expect(netsuite.record.created[0]!.persistedLines).toEqual({});
  });
});

describe("end to end: add and remove lines", () => {
  const BUILD = readFileSync(new URL("../examples/build-order.sail", import.meta.url), "utf8");
  const CLEAN = readFileSync(new URL("../examples/clean-order.sail", import.meta.url), "utf8");

  it("constructs a sales order with two lines and persists them on save", () => {
    const result = compileSail(BUILD, "examples/build-order.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toMatchSnapshot();
    expect(result.output).toContain('define(["N/record"], (record) => {');
    const netsuite = new FakeNetSuite();
    netsuite.load(result.output!).execute!(scheduledContext());
    const order = netsuite.record.created[0]!;
    expect(order.insertLineCalls).toEqual([{ sublistId: "item", line: 0 }, { sublistId: "item", line: 1 }]);
    expect(order.persistedLines).toEqual({
      item: [
        { item: "100", quantity: 2, rate: 10 },
        { item: "200", quantity: 1, rate: 25 },
      ],
    });
    expect(netsuite.record.exists("salesorder", "1000")).toBe(true);
  });

  it("removes exactly the zero-quantity lines, including adjacent ones, in forward order", () => {
    const result = compileSail(CLEAN, "examples/clean-order.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toMatchSnapshot();
    const netsuite = new FakeNetSuite();
    const order = netsuite.record.seed("salesorder", "123", {}, {
      item: [
        { item: "a", quantity: 0 },
        { item: "b", quantity: 0 },
        { item: "c", quantity: 1 },
        { item: "d", quantity: 0 },
        { item: "e", quantity: 2 },
        { item: "f", quantity: 0 },
      ],
    });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(order.removeLineCalls).toEqual([
      { sublistId: "item", line: 0 },
      { sublistId: "item", line: 0 },
      { sublistId: "item", line: 1 },
      { sublistId: "item", line: 2 },
    ]);
    expect(order.persistedLines!.item!.map((l) => l.item)).toEqual(["c", "e"]);
    expect(order.saveCount).toBe(1);
  });

  it("unsaved adds and removes stay in memory", () => {
    const result = compileSail(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        remove line\n    }\n    add order.item {\n        item = "new"\n    }\n}\n`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["SAIL2001", "SAIL2001"]);
    const netsuite = new FakeNetSuite();
    const order = netsuite.record.seed("salesorder", "1", {}, { item: [{ item: "old" }] });
    order.save();
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(order.getLineCount({ sublistId: "item" })).toBe(1);
    expect(order.getSublistValue({ sublistId: "item", fieldId: "item", line: 0 })).toBe("new");
    expect(order.persistedLines).toEqual({ item: [{ item: "old" }] });
  });

  it("adds lines to a copy using locals as values, and the while-form loop reads fields after a removal correctly", () => {
    const result = compileSail(
      `scheduled {\n    let qty = 4\n    let order = copy SalesOrder("1")\n    add order.item {\n        item = "x"\n        quantity = qty\n    }\n    for line in order.item {\n        if line.item == "drop" {\n            remove line\n        } else {\n            line.description = line.item\n        }\n    }\n    save order\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("salesorder", "1", {}, { item: [{ item: "drop" }, { item: "keep" }, { item: "drop" }] });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.record.created[0]!.persistedLines!.item).toEqual([
      { item: "keep", description: "keep" },
      { item: "x", quantity: 4, description: "x" },
    ]);
    expect(netsuite.record.load({ type: "salesorder", id: "1" }).getLineCount({ sublistId: "item" })).toBe(3);
  });
});

describe("end to end: functions", () => {
  const REVIEW = readFileSync(new URL("../examples/review-orders.sail", import.meta.url), "utf8");

  it("compiles the flagship example to plain functions and runs it", () => {
    const result = compileSail(REVIEW, "examples/review-orders.sail");
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toMatchSnapshot();
    expect(result.output).toContain("function removeEmptyLines(order) {");
    expect(result.output).toContain("function needsReview(memo) {\n        return memo === \"\" || memo === \"TBD\";\n    }");
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("salesorder", "1", { memo: "" }, { item: [{ item: "a", quantity: 0 }, { item: "b", quantity: 3 }] });
    netsuite.record.seed("salesorder", "2", { memo: "Keep" }, { item: [{ item: "c", quantity: 0 }] });
    netsuite.record.seed("salesorder", "3", { memo: "TBD" });
    netsuite.load(result.output!).execute!(scheduledContext());
    const memo = (id: string) => netsuite.record.load({ type: "salesorder", id }).getValue({ fieldId: "memo" });
    expect([memo("1"), memo("2"), memo("3")]).toEqual(["Reviewed by Sail", "Keep", "Reviewed by Sail"]);
    expect(netsuite.record.load({ type: "salesorder", id: "1" }).persistedLines!.item!.map((l) => l.item)).toEqual(["b"]);
    expect(netsuite.record.load({ type: "salesorder", id: "2" }).persistedLines!.item).toEqual([]);
  });

  it("functions can save, call each other, return values, and use names the backend must rename", () => {
    const result = compileSail(
      `fn label(record: Customer) -> Text {\n    return record.email\n}\nfn stamp(record: Customer, note: Text) {\n    record.comments = note\n    save record\n}\nscheduled {\n    let record = load Customer("1")\n    stamp(record, label(record))\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    expect(result.output).toContain('define(["N/record"], (record$) => {');
    expect(result.output).toContain("function label(record) {");
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "1", { email: "a@b.c", comments: "" });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.record.persisted("customer", "1")).toEqual({ email: "a@b.c", comments: "a@b.c" });
  });
});
