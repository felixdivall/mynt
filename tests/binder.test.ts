import { describe, expect, it } from "vitest";
import { isRecordType, typeName } from "../src/semantic/types.js";
import { compileSail, errorCodes, schema } from "./helpers.js";

describe("semantic checks", () => {
  it("SAIL1001 unknown record type", () => {
    const result = compileSail(`beforeSubmit create (x: Widget) {\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1001"]);
    expect(result.diagnostics[0]!.message).toContain("Known record types: Customer, Invoice, SailLog, SalesOrder");
    expect(result.unit).toBeUndefined();
  });

  it("SAIL1002 unknown event name", () => {
    const result = compileSail(`beforeSubmit create | explode (c: Customer) {\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1002"]);
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 1, column: 23 });
  });

  it("SAIL1003 mixed record types in one file", () => {
    const result = compileSail(
      `beforeSubmit create (c: Customer) {\n}\nafterSubmit create (o: SalesOrder) {\n}\n`,
    );
    expect(errorCodes(result)).toEqual(["SAIL1003"]);
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 24 });
  });

  it("SAIL1004 unknown field on read as well as write", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    c.email = c.nope\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1004"]);
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 2, column: 17 });
  });

  it("SAIL1005 assignment to a read-only field", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    c.entityid = "X"\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1005"]);
    expect(result.diagnostics[0]!.message).toBe("Customer.entityid is read-only and cannot be assigned");
  });

  it("SAIL1006 assignment type mismatch", () => {
    const result = compileSail(`beforeSubmit create (o: SalesOrder) {\n    o.memo = o.total\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1006"]);
    expect(result.diagnostics[0]!.message).toBe("Cannot assign Number to SalesOrder.memo, which is Text");
  });

  it("SAIL1006 a bare record is not a value", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    c.email = c\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1006"]);
  });

  it("SAIL1007 writing the bound record in afterSubmit is an error", () => {
    const result = compileSail(`afterSubmit create (c: Customer) {\n    c.comments = "late"\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1007"]);
    expect(result.diagnostics[0]!.message).toContain("already saved");
  });

  it("SAIL1008 duplicate entry point", () => {
    const result = compileSail(
      `beforeSubmit create (c: Customer) {\n}\nbeforeSubmit edit (c: Customer) {\n}\n`,
    );
    expect(errorCodes(result)).toEqual(["SAIL1008"]);
  });

  it("SAIL1009 only fields can be assigned", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    c = "x"\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1009"]);
  });

  it("SAIL1010 unknown identifier", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    customer.comments = "x"\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1010"]);
    expect(result.diagnostics[0]!.message).toBe("Unknown identifier 'customer'. Names in scope: c, copy, create, load, log, transform");
  });

  it("SAIL1011 member access on a non-record value", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    c.email = c.comments.length\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1011"]);
  });

  it("reports every error in a file, not just the first", () => {
    const result = compileSail(
      `beforeSubmit create (c: Customer) {\n    c.nope = "x"\n    c.entityid = "y"\n    c.email = "ok"\n}\n`,
    );
    expect(errorCodes(result)).toEqual(["SAIL1004", "SAIL1005"]);
    // The valid statement still binds.
    expect(result.unit?.entryPoints[0]?.body).toHaveLength(1);
    expect(result.output).toBeUndefined();
  });

  it("accepts a field read as an assignment value", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    c.comments = c.email\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain('value: c.getValue({\n                fieldId: "email"\n            })');
  });

  it("accepts beforeSubmit and afterSubmit together on one record type", () => {
    const result = compileSail(
      `beforeSubmit create (c: Customer) {\n    c.comments = "a"\n}\n\nafterSubmit create | edit (c: Customer) {\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("return { beforeSubmit, afterSubmit };");
  });

  it("an entry point with no event filter runs for every event", () => {
    const result = compileSail(`beforeSubmit (c: Customer) {\n    c.comments = "a"\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).not.toContain("context.UserEventType");
  });
});

describe("built-ins and dependency inference", () => {
  it("binds log.debug to the log.debug built-in", () => {
    const result = compileSail(`scheduled {\n    log.debug("Hello")\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.unit?.kind).toBe("Scheduled");
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error("expected scheduled unit");
    expect(unit.entryPoint.hook).toBe("execute");
    expect(unit.entryPoint.body).toHaveLength(1);
    expect(unit.entryPoint.body[0]).toMatchObject({
      kind: "ExpressionStatement",
      expression: {
        kind: "BuiltinCall",
        builtin: { id: "log.debug", module: "N/log" },
        arguments: [{ kind: "StringLiteral", value: "Hello" }],
        type: "Void",
      },
    });
    expect(unit.entryPoint.body[0]!.span.start).toMatchObject({ line: 2, column: 5 });
  });

  it.each(["debug", "audit", "error", "emergency"])("supports log.%s", (level) => {
    const result = compileSail(`scheduled {\n    log.${level}("x")\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain(`log.${level}({`);
  });

  it("SAIL1016 rejects an unsupported log method", () => {
    const result = compileSail(`scheduled {\n    log.info("x")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1016"]);
    expect(result.diagnostics[0]!.message).toBe(
      "'info' is not a supported log method. Supported log methods: debug, audit, error, emergency",
    );
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 2, column: 9 });
  });

  it("SAIL1013 rejects the wrong argument count", () => {
    const none = compileSail(`scheduled {\n    log.debug()\n}\n`);
    expect(errorCodes(none)).toEqual(["SAIL1013"]);
    expect(none.diagnostics[0]!.message).toBe("log.debug expects 1 argument, but received 0");

    const two = compileSail(`scheduled {\n    log.debug("one", "two")\n}\n`);
    expect(errorCodes(two)).toEqual(["SAIL1013"]);
    expect(two.diagnostics[0]!.message).toBe("log.debug expects 1 argument, but received 2");
  });

  it("SAIL1014 rejects a non-Text argument", () => {
    const result = compileSail(`beforeSubmit create (o: SalesOrder) {\n    log.debug(o.total)\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1014"]);
    expect(result.diagnostics[0]!.message).toBe("log.debug argument 1 must be Text, but received Number");
  });

  it("SAIL1012 rejects calling a namespace, a record, or a value", () => {
    const ns = compileSail(`scheduled {\n    log("x")\n}\n`);
    expect(errorCodes(ns)).toEqual(["SAIL1012"]);
    expect(ns.diagnostics[0]!.message).toContain("'log' is a built-in namespace and cannot be called");

    const rec = compileSail(`beforeSubmit create (c: Customer) {\n    c()\n}\n`);
    expect(errorCodes(rec)).toEqual(["SAIL1012"]);

    const val = compileSail(`beforeSubmit create (c: Customer) {\n    c.email()\n}\n`);
    expect(errorCodes(val)).toEqual(["SAIL1012"]);
  });

  it("SAIL1006 an uncalled built-in or a namespace is not a value", () => {
    const uncalled = compileSail(`scheduled {\n    log.debug\n}\n`);
    expect(errorCodes(uncalled)).toEqual(["SAIL1006"]);
    expect(uncalled.diagnostics[0]!.message).toContain("must be called");

    const assigned = compileSail(`beforeSubmit create (c: Customer) {\n    c.email = log\n}\n`);
    expect(errorCodes(assigned)).toEqual(["SAIL1006"]);

    const voidValue = compileSail(`beforeSubmit create (c: Customer) {\n    c.email = log.debug("x")\n}\n`);
    expect(errorCodes(voidValue)).toEqual(["SAIL1006"]);
    expect(voidValue.diagnostics[0]!.message).toBe("Cannot assign Void to Customer.email, which is Text");
  });

  it("SAIL1010 unknown root identifier in a scheduled script lists built-ins", () => {
    const result = compileSail(`scheduled {\n    logger.debug("x")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1010"]);
    expect(result.diagnostics[0]!.message).toBe("Unknown identifier 'logger'. Names in scope: copy, create, load, log, transform");
  });

  it("SAIL1015 rejects mixing scheduled and user event entry points", () => {
    const result = compileSail(
      `scheduled {\n    log.debug("Hello")\n}\n\nbeforeSubmit create (c: Customer) {\n    c.comments = "Hello"\n}\n`,
    );
    expect(errorCodes(result)).toEqual(["SAIL1015"]);
    expect(result.diagnostics[0]!.message).toContain("cannot exist in the same Sail script");
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 5, column: 1 });
    // The file still binds as the kind it started with.
    expect(result.unit?.kind).toBe("Scheduled");
    expect(result.output).toBeUndefined();
  });

  it("SAIL1008 rejects two scheduled blocks", () => {
    const result = compileSail(`scheduled {\n}\nscheduled {\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1008"]);
  });

  it("infers N/log once however many log calls there are", () => {
    const result = compileSail(`scheduled {\n    log.debug("a")\n    log.audit("b")\n    log.error("c")\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect([...result.unit!.dependencies]).toEqual(["N/log"]);
    expect(result.output).toContain('define(["N/log"], (log) => {');
    expect(result.output!.match(/"N\/log"/g)).toHaveLength(1);
  });

  it("infers no dependencies for a user event that only writes fields", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    c.comments = "x"\n}\n`);
    expect([...result.unit!.dependencies]).toEqual([]);
    expect(result.output).toContain("define([], () => {");
  });

  it("infers N/log for a user event that logs", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    log.audit("x")\n    c.comments = "y"\n}\n`);
    expect([...result.unit!.dependencies]).toEqual(["N/log"]);
    expect(result.output).toContain('define(["N/log"], (log) => {');
  });

  it("a parameter named log shadows the built-in and drops the dependency", () => {
    const result = compileSail(`beforeSubmit create (log: Customer) {\n    log.comments = "x"\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect([...result.unit!.dependencies]).toEqual([]);
  });
});

describe("load, locals, and record types", () => {
  const LOAD = `scheduled {\n    let customer = load Customer("123")\n    log.debug(customer.email)\n}\n`;

  it("binds load Customer(...) to a Customer-typed call with the resolved record", () => {
    const result = compileSail(LOAD);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error("expected scheduled");
    const [declaration] = unit.entryPoint.body;
    expect(declaration).toMatchObject({
      kind: "LocalDeclaration",
      local: { name: "customer", origin: "let", type: { kind: "Record", record: { id: "customer", name: "Customer" } } },
      initializer: {
        kind: "BuiltinCall",
        builtin: { id: "load", module: "N/record", kind: "recordOperation", returns: "subject", result: "existing" },
        recordType: { kind: "RecordTypeReference", record: { id: "customer", suiteScriptType: "CUSTOMER" } },
        arguments: [{ kind: "StringLiteral", value: "123" }],
        type: { kind: "Record", record: { name: "Customer" } },
      },
    });
    expect(declaration!.span.start).toMatchObject({ line: 2, column: 5 });
  });

  it("load SalesOrder(...) returns SalesOrder", () => {
    const result = compileSail(`scheduled {\n    let order = load SalesOrder("456")\n    log.audit(order.memo)\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("type: record.Type.SALES_ORDER");
  });

  it("resolves field access on a loaded record through the same FieldRead path", () => {
    const result = compileSail(LOAD);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error("expected scheduled");
    const statement = unit.entryPoint.body[1]!;
    expect(statement).toMatchObject({
      kind: "ExpressionStatement",
      expression: {
        builtin: { id: "log.debug" },
        arguments: [
          {
            kind: "FieldRead",
            receiver: { kind: "LocalReference", local: { name: "customer" } },
            field: { id: "email", type: "Text" },
            type: "Text",
          },
        ],
      },
    });
  });

  it("SAIL1004 unknown field on a loaded record uses the Customer field diagnostic", () => {
    const result = compileSail(`scheduled {\n    let customer = load Customer("123")\n    log.debug(customer.notAField)\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1004"]);
    expect(result.diagnostics[0]!.message).toBe("Customer has no field 'notAField'");
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 24 });
  });

  it("SAIL1004 suggests a close field name", () => {
    const result = compileSail(`scheduled {\n    let customer = load Customer("123")\n    log.debug(customer.emial)\n}\n`);
    expect(result.diagnostics[0]!.message).toBe("Customer has no field 'emial'. Did you mean 'email'?");
  });

  it("SAIL1017 rejects a duplicate local", () => {
    const result = compileSail(`scheduled {\n    let customer = load Customer("1")\n    let customer = load Customer("2")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1017"]);
    expect(result.diagnostics[0]!.message).toBe("'customer' is already declared in this scope as a local (line 2)");
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 9 });
  });

  it("SAIL1017 rejects shadowing the entry point parameter", () => {
    const result = compileSail(`beforeSubmit create (c: Customer) {\n    let c = load Customer("1")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1017"]);
    expect(result.diagnostics[0]!.message).toContain("as the entry point parameter");
  });

  it("SAIL1010 rejects an unknown local", () => {
    const result = compileSail(`scheduled {\n    log.debug(customer.email)\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1010"]);
    expect(result.diagnostics[0]!.message).toBe("Unknown identifier 'customer'. Names in scope: copy, create, load, log, transform");
  });

  it("SAIL1010 suggests a close local name", () => {
    const result = compileSail(`scheduled {\n    let customer = load Customer("1")\n    log.debug(custome.email)\n}\n`);
    expect(result.diagnostics[0]!.message).toBe(
      "Unknown identifier 'custome'. Did you mean 'customer'? Names in scope: customer, copy, create, load, log, transform",
    );
  });

  it("SAIL1006 a Void call cannot initialize a local", () => {
    const result = compileSail(`scheduled {\n    let x = log.debug("Hello")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1006"]);
    expect(result.diagnostics[0]!.message).toBe("Cannot initialize 'x' with log.debug(...), which returns Void");
  });

  it("SAIL1001 unknown record type in load suggests the right one", () => {
    const result = compileSail(`scheduled {\n    let c = load Custmer("123")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1001"]);
    expect(result.diagnostics[0]!.message).toBe(
      "Unknown record type 'Custmer'. Did you mean 'Customer'? Known record types: Customer, Invoice, SailLog, SalesOrder",
    );
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 2, column: 18 });
  });

  it("SAIL1001 unknown record type on an entry point parameter also suggests", () => {
    const result = compileSail(`beforeSubmit create (o: SalesOrdr) {\n}\n`);
    expect(result.diagnostics[0]!.message).toContain("Did you mean 'SalesOrder'?");
  });

  it("SAIL1013 rejects load with no id", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer()\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1013"]);
    expect(result.diagnostics[0]!.message).toBe("load expects 1 argument, but received 0");
  });

  it("SAIL1018 rejects load without a record type", () => {
    const result = compileSail(`scheduled {\n    let c = load("123")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1018"]);
    expect(result.diagnostics[0]!.message).toBe("load expects a record type before the argument list, like load Customer(...)");
  });

  it("SAIL1018 rejects a value where a record type belongs", () => {
    const result = compileSail(`scheduled {\n    let a = load Customer("1")\n    let b = load a("2")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1018"]);
    expect(result.diagnostics[0]!.message).toBe(
      "load expects a record type, but 'a' is a Customer value. Write the type name, like load Customer(...)",
    );
  });

  it("SAIL1018 rejects a record type on a built-in that takes none", () => {
    const result = compileSail(`scheduled {\n    log.debug Customer("x")\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1018"]);
    expect(result.diagnostics[0]!.message).toBe("log.debug does not take a record type; write log.debug(...)");
  });

  it("Customer in value position is a record type, not a value", () => {
    const asValue = compileSail(`scheduled {\n    log.debug(Customer)\n}\n`);
    expect(errorCodes(asValue)).toEqual(["SAIL1006"]);
    expect(asValue.diagnostics[0]!.message).toContain("'Customer' is a record type, not a value");

    const asReceiver = compileSail(`scheduled {\n    log.debug(Customer.email)\n}\n`);
    expect(errorCodes(asReceiver)).toEqual(["SAIL1011"]);

    const called = compileSail(`scheduled {\n    Customer("1")\n}\n`);
    expect(errorCodes(called)).toEqual(["SAIL1012"]);
    expect(called.diagnostics[0]!.message).toContain("Did you mean 'load Customer(...)'");
  });

  it("SAIL1009 fields can only be assigned on a named record", () => {
    const result = compileSail(`scheduled {\n    load Customer("1").email = "x"\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1009"]);
    expect(result.diagnostics[0]!.message).toBe(
      "Assign fields on a named record: declare it first, like 'let x = load Customer(...)', then write 'x.email'",
    );
  });

  it("SAIL1014 a loaded record is not a Text argument", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    log.debug(c)\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1014"]);
    expect(result.diagnostics[0]!.message).toBe("log.debug argument 1 must be Text, but received Customer");
  });

  it("a failed initializer does not declare the local or cascade into Void", () => {
    const result = compileSail(`scheduled {\n    let a = load Custmer("1")\n    log.debug(a.email)\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1001", "SAIL1010"]);
  });

  it("infers only N/record for a bare load", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("123")\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect([...result.unit!.dependencies]).toEqual(["N/record"]);
    expect(result.output).toContain('define(["N/record"], (record) => {');
  });

  it("composes N/log and N/record in sorted order, each once", () => {
    const result = compileSail(`scheduled {\n    let a = load Customer("1")\n    let b = load SalesOrder("2")\n    log.debug(a.email)\n    log.audit(b.memo)\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect([...result.unit!.dependencies].sort()).toEqual(["N/log", "N/record"]);
    expect(result.output).toContain('define(["N/log", "N/record"], (log, record) => {');
  });

  it("load works inside a user event and keeps the entry point record writable", () => {
    const result = compileSail(
      `beforeSubmit create (c: Customer) {\n    let other = load Customer("9")\n    c.comments = other.email\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect([...result.unit!.dependencies]).toEqual(["N/record"]);
    expect(result.output).toContain("const other = record.load({");
  });
});

describe("record lifecycle: writes and save", () => {
  const LIFECYCLE = `scheduled {\n    let customer = load Customer("123")\n    customer.comments = "Updated by Sail"\n    save customer\n}\n`;

  it("binds load, write, and save on a loaded record", () => {
    const result = compileSail(LIFECYCLE);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error("expected scheduled");
    expect(unit.entryPoint.body.map((s) => s.kind)).toEqual(["LocalDeclaration", "FieldWrite", "SaveRecord"]);
    expect(unit.entryPoint.body[1]).toMatchObject({
      receiver: { kind: "LocalReference", local: { name: "customer", type: { origin: "owned" } } },
      field: { id: "comments", writable: true },
      value: { kind: "StringLiteral", value: "Updated by Sail" },
    });
    expect(unit.entryPoint.body[2]).toMatchObject({
      kind: "SaveRecord",
      target: { kind: "LocalReference", local: { name: "customer" }, type: { kind: "Record", origin: "owned" } },
    });
    expect(unit.entryPoint.body[2]!.span.start).toMatchObject({ line: 4, column: 5 });
  });

  it("origin is carried on the type: context for parameters, loaded for load results", () => {
    const ue = compileSail(`beforeSubmit create (c: Customer) {\n    let other = load Customer("1")\n    c.comments = other.email\n    save other\n}\n`);
    expect(ue.diagnostics).toEqual([]);
    const unit = ue.unit!;
    if (unit.kind !== "UserEvent") throw new Error("expected user event");
    expect(unit.entryPoints[0]!.parameter.type).toMatchObject({ kind: "Record", origin: "context" });
    expect(unit.entryPoints[0]!.body[0]).toMatchObject({
      kind: "LocalDeclaration",
      local: { type: { origin: "owned" } },
      initializer: { kind: "BuiltinCall", type: { origin: "owned" } },
    });
  });

  it("origin and record type are preserved through local references", () => {
    const result = compileSail(`scheduled {\n    let a = load SalesOrder("1")\n    a.memo = "x"\n    save a\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error("expected scheduled");
    const save = unit.entryPoint.body[2]!;
    if (save.kind !== "SaveRecord") throw new Error("expected save");
    expect(save.target.type).toMatchObject({ kind: "Record", origin: "owned", record: { name: "SalesOrder" } });
  });

  it("SAIL1005 read-only fields stay read-only on loaded records", () => {
    const result = compileSail(`scheduled {\n    let order = load SalesOrder("123")\n    order.total = "100"\n    save order\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1005"]);
    expect(result.diagnostics[0]!.message).toBe("SalesOrder.total is read-only and cannot be assigned");
  });

  it("SAIL1006 field type checks apply to loaded records", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    let o = load SalesOrder("2")\n    c.email = o.total\n    save c\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1006"]);
    expect(result.diagnostics[0]!.message).toBe("Cannot assign Number to Customer.email, which is Text");
  });

  it("SAIL1020 saving the beforeSubmit record is rejected with the lifecycle explanation", () => {
    const result = compileSail(`beforeSubmit edit (customer: Customer) {\n    save customer\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1020"]);
    expect(result.diagnostics[0]!.message).toBe(
      "'customer' is the Customer from beforeSubmit and cannot be explicitly saved: " +
        "NetSuite persists changes to it automatically when beforeSubmit returns",
    );
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 2, column: 5 });
  });

  it("SAIL1020 saving the afterSubmit record explains it is already saved", () => {
    const result = compileSail(`afterSubmit edit (customer: Customer) {\n    save customer\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1020"]);
    expect(result.diagnostics[0]!.message).toContain("it was already saved before afterSubmit ran");
    expect(result.diagnostics[0]!.message).toContain("let x = load Customer(...)");
  });

  it("afterSubmit may load, modify, and save its own copy", () => {
    const result = compileSail(
      `afterSubmit edit (customer: Customer) {\n    let fresh = load Customer("1")\n    fresh.comments = "x"\n    save fresh\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("fresh.save();");
  });

  it("SAIL1019 saving a non-record", () => {
    const local = compileSail(`scheduled {\n    let c = load Customer("1")\n    let e = c.email\n    save e\n}\n`);
    expect(errorCodes(local)).toEqual(["SAIL1019"]);
    expect(local.diagnostics[0]!.message).toBe("'e' is a Text value and cannot be saved. Only records can be saved");

    const expr = compileSail(`scheduled {\n    let c = load Customer("1")\n    save c.email\n}\n`);
    expect(errorCodes(expr)).toEqual(["SAIL1019"]);
    expect(expr.diagnostics[0]!.message).toBe("A Text value cannot be saved. Only records can be saved");
  });

  it("SAIL1010 saving an unknown identifier uses the existing diagnostic", () => {
    const result = compileSail(`scheduled {\n    save customer\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1010"]);
    expect(result.diagnostics[0]!.message).toBe("Unknown identifier 'customer'. Names in scope: copy, create, load, log, transform");
  });

  it("duplicate saves are allowed", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    save c\n    save c\n}\n`);
    expect(result.diagnostics).toEqual([]);
  });

  it("save adds no dependency: load + save needs only N/record", () => {
    const result = compileSail(LIFECYCLE);
    expect([...result.unit!.dependencies]).toEqual(["N/record"]);
    expect(result.output).toContain('define(["N/record"], (record) => {');
  });

  it("a user event write still needs no modules and no save", () => {
    const result = compileSail(`beforeSubmit edit (customer: Customer) {\n    customer.comments = "Changed"\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("define([], () => {");
    expect(result.output).not.toContain(".save()");
  });

  it("a local named save still works", () => {
    const result = compileSail(`scheduled {\n    let save = load Customer("1")\n    save.comments = "x"\n    save save\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("save.save();");
  });
});

describe("SAIL2001 unsaved mutation warning", () => {
  function warnings(source: string) {
    const result = compileSail(source);
    return { result, warnings: result.diagnostics.filter((d) => d.severity === "warning") };
  }

  it("warns when a loaded record is modified but never saved, and still compiles", () => {
    const { result, warnings: w } = warnings(`scheduled {\n    let customer = load Customer("123")\n    customer.comments = "Changed"\n}\n`);
    expect(errorCodes(result)).toEqual([]);
    expect(result.output).toBeDefined();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: "SAIL2001", span: { start: { line: 3, column: 5 } } });
    expect(w[0]!.message).toBe(
      "'customer' is modified but never saved; changes to a loaded Customer are discarded unless you 'save customer'",
    );
  });

  it("warns when a write follows the last save", () => {
    const { warnings: w } = warnings(`scheduled {\n    let c = load Customer("1")\n    c.comments = "a"\n    save c\n    c.comments = "b"\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.span.start.line).toBe(5);
    expect(w[0]!.message).toContain("modified after its last save");
  });

  it("does not warn when every write precedes a save", () => {
    const { warnings: w } = warnings(`scheduled {\n    let c = load Customer("1")\n    c.comments = "a"\n    c.email = "b"\n    save c\n}\n`);
    expect(w).toEqual([]);
  });

  it("does not warn for context records", () => {
    const { warnings: w } = warnings(`beforeSubmit edit (customer: Customer) {\n    customer.comments = "Changed"\n}\n`);
    expect(w).toEqual([]);
  });

  it("tracks records independently", () => {
    const { warnings: w } = warnings(`scheduled {\n    let a = load Customer("1")\n    let b = load SalesOrder("2")\n    a.comments = "x"\n    b.memo = "y"\n    save a\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("'b' is modified but never saved");
  });
});

describe("comparisons and if", () => {
  it("binds Text == Text to a Bool comparison with both operand types resolved", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n    }\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const statement = unit.entryPoint.body[1]!;
    expect(statement).toMatchObject({
      kind: "If",
      condition: {
        kind: "Comparison",
        operation: "Equal",
        operandType: "Text",
        type: "Bool",
        left: { kind: "FieldRead", field: { id: "email" }, type: "Text" },
        right: { kind: "StringLiteral", value: "" },
      },
      thenBody: [],
      elseBody: undefined,
    });
  });

  it("binds every operator to its operation", () => {
    const result = compileSail(
      `scheduled {\n    let o = load SalesOrder("1")\n    if o.memo != "" { }\n    if o.total < 1 { }\n    if o.total <= 1 { }\n    if o.total > 1 { }\n    if o.total >= 1 { }\n    if o.total == 10 { }\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const operations = unit.entryPoint.body.slice(1).map((s) => (s.kind === "If" && s.condition.kind === "Comparison" ? s.condition.operation : null));
    expect(operations).toEqual(["NotEqual", "Less", "LessOrEqual", "Greater", "GreaterOrEqual", "Equal"]);
    const last = unit.entryPoint.body[6]!;
    expect(last).toMatchObject({ condition: { operandType: "Number", right: { kind: "NumberLiteral", value: 10, type: "Number" } } });
  });

  it("a comparison can initialize a Bool local", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    let missing = c.email == ""\n    if missing {\n    }\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    expect(unit.entryPoint.body[1]).toMatchObject({ kind: "LocalDeclaration", local: { name: "missing", type: "Bool" } });
    expect(unit.entryPoint.body[2]).toMatchObject({ kind: "If", condition: { kind: "LocalReference", type: "Bool" } });
  });

  it("SAIL1022 rejects comparing Text with Number", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email == 42 {\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1022"]);
    expect(result.diagnostics[0]!.message).toBe("Cannot compare Text with Number: both sides of '==' must have the same type");
    expect(result.diagnostics[0]!.span).toMatchObject({ start: { line: 3, column: 8 }, end: { line: 3, column: 21 } });
  });

  it("SAIL1022 rejects comparing a record with Text", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c == "" {\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1022"]);
    expect(result.diagnostics[0]!.message).toBe("Cannot compare Customer with Text: both sides of '==' must have the same type");
  });

  it("SAIL1023 rejects ordering Text", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email < "abc" {\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1023"]);
    expect(result.diagnostics[0]!.message).toBe("'<' is not defined for Text values; ordering comparisons require Number operands");
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 16 });
  });

  it("SAIL1023 rejects comparing records, Bools, and Void", () => {
    const records = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c == c {\n    }\n}\n`);
    expect(errorCodes(records)).toEqual(["SAIL1023"]);
    expect(records.diagnostics[0]!.message).toBe("'==' is not defined for records (Customer); comparisons are defined for Text and Number values");

    const bools = compileSail(`scheduled {\n    let c = load Customer("1")\n    let a = c.email == ""\n    if a == a {\n    }\n}\n`);
    expect(errorCodes(bools)).toEqual(["SAIL1023"]);
    expect(bools.diagnostics[0]!.message).toContain("'==' is not defined for Bool values");

    const voids = compileSail(`scheduled {\n    if log.debug("a") == log.debug("b") {\n    }\n}\n`);
    expect(errorCodes(voids)).toEqual(["SAIL1023"]);
    expect(voids.diagnostics[0]!.message).toContain("'==' is not defined for Void values");
  });

  it("SAIL1021 if requires a Bool condition: no truthiness", () => {
    const text = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email {\n    }\n}\n`);
    expect(errorCodes(text)).toEqual(["SAIL1021"]);
    expect(text.diagnostics[0]!.message).toBe(
      "if condition must be Bool, but received Text. Sail has no truthiness: compare the value explicitly, for example with == or !=",
    );
    expect(text.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 8 });

    const record = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c {\n    }\n}\n`);
    expect(record.diagnostics[0]!.message).toContain("if condition must be Bool, but received Customer");

    const voidCall = compileSail(`scheduled {\n    if log.debug("x") {\n    }\n}\n`);
    expect(voidCall.diagnostics[0]!.message).toContain("if condition must be Bool, but received Void");
  });

  it("reports errors inside both branches even when the condition is bad", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email {\n        c.nope = "x"\n    } else {\n        c.entityid = "y"\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1021", "SAIL1004", "SAIL1005"]);
  });

  it("reports errors in both operands of a comparison", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.nope == c.nada {\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1004", "SAIL1004"]);
  });

  it("a comparison is bound but has nothing to emit as a statement", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    c.email == ""\n    c.nope == ""\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1004"]);
  });

  it("field access, mutation, and save work inside a branch, and the record stays loaded throughout", () => {
    const result = compileSail(
      `scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        log.debug(c.entityid)\n        c.comments = "x"\n        save c\n    } else {\n        c.comments = "y"\n        save c\n    }\n    c.comments = "z"\n    save c\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const [, branch, afterWrite, afterSave] = unit.entryPoint.body;
    if (branch?.kind !== "If") throw new Error();
    expect(branch.thenBody.map((s) => s.kind)).toEqual(["ExpressionStatement", "FieldWrite", "SaveRecord"]);
    expect(branch.elseBody?.map((s) => s.kind)).toEqual(["FieldWrite", "SaveRecord"]);
    const inside = branch.thenBody[1]!;
    if (inside.kind !== "FieldWrite") throw new Error();
    expect(inside.receiver.local.type).toMatchObject({ kind: "Record", record: { name: "Customer" }, origin: "owned" });
    if (afterWrite?.kind !== "FieldWrite") throw new Error();
    expect(afterWrite.receiver.local).toBe(inside.receiver.local);
    expect(afterSave?.kind).toBe("SaveRecord");
    expect([...unit.dependencies].sort()).toEqual(["N/log", "N/record"]);
  });

  it("context-record rules apply inside branches too", () => {
    const result = compileSail(`afterSubmit edit (c: Customer) {\n    if c.email == "" {\n        c.comments = "x"\n        save c\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1007", "SAIL1020"]);
  });

  it("an if with a failed condition still records dependencies from its body", () => {
    const result = compileSail(`scheduled {\n    if nope {\n        log.debug("x")\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1010"]);
    expect([...result.unit!.dependencies]).toEqual(["N/log"]);
  });
});

describe("block scope", () => {
  it("SAIL1010 a let inside an if is not visible after the block", () => {
    const result = compileSail(`scheduled {\n    let a = load Customer("1")\n    if a.email == "" {\n        let b = load Customer("2")\n    }\n    save b\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1010"]);
    expect(result.diagnostics[0]!.message).toBe("Unknown identifier 'b'. Did you mean 'a'? Names in scope: a, copy, create, load, log, transform");
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 6, column: 10 });
  });

  it("a block sees enclosing locals", () => {
    const result = compileSail(`scheduled {\n    let a = load Customer("1")\n    if a.email == "" {\n        if a.comments == "" {\n            save a\n        }\n    }\n}\n`);
    expect(result.diagnostics).toEqual([]);
  });

  it("SAIL1017 a block cannot shadow an enclosing local or the parameter", () => {
    const local = compileSail(`scheduled {\n    let a = load Customer("1")\n    if a.email == "" {\n        let a = load Customer("2")\n    }\n}\n`);
    expect(errorCodes(local)).toEqual(["SAIL1017"]);
    expect(local.diagnostics[0]!.message).toBe("'a' is already declared in an enclosing scope as a local (line 2)");

    const parameter = compileSail(`beforeSubmit edit (c: Customer) {\n    if c.email == "" {\n        let c = load Customer("2")\n    }\n}\n`);
    expect(errorCodes(parameter)).toEqual(["SAIL1017"]);
    expect(parameter.diagnostics[0]!.message).toBe("'c' is already declared in an enclosing scope as the entry point parameter (line 1)");
  });

  it("sibling blocks may declare the same name", () => {
    const result = compileSail(
      `scheduled {\n    let a = load Customer("1")\n    if a.email == "" {\n        let n = "x"\n        log.debug(n)\n    } else {\n        let n = "y"\n        log.debug(n)\n    }\n    if a.email == "" {\n        let n = "z"\n        log.debug(n)\n    }\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("SAIL1017 duplicates within one block are still caught", () => {
    const result = compileSail(`scheduled {\n    let a = load Customer("1")\n    if a.email == "" {\n        let n = "x"\n        let n = "y"\n    }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1017"]);
    expect(result.diagnostics[0]!.message).toBe("'n' is already declared in this scope as a local (line 4)");
  });
});

describe("SAIL2001 across control flow", () => {
  function warnings(source: string) {
    const result = compileSail(source);
    expect(errorCodes(result)).toEqual([]);
    return result.diagnostics.filter((d) => d.severity === "warning");
  }

  it("no warning: the mutated path saves and the other path has no mutation", () => {
    expect(warnings(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        c.comments = "Missing"\n        save c\n    }\n}\n`)).toEqual([]);
  });

  it("warning: mutation in a branch with no save anywhere", () => {
    const w = warnings(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        c.comments = "Missing"\n    }\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: "SAIL2001", span: { start: { line: 4, column: 9 } } });
    expect(w[0]!.message).toBe("'c' is modified but never saved; changes to a loaded Customer are discarded unless you 'save c'");
  });

  it("warning: unconditional mutation, conditional save", () => {
    const w = warnings(`scheduled {\n    let c = load Customer("1")\n    c.comments = "Changed"\n    if c.email == "" {\n        save c\n    }\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.span.start).toMatchObject({ line: 3, column: 5 });
    expect(w[0]!.message).toBe(
      "'c' may leave this script with unsaved changes: it is modified here, but not every execution path that follows performs 'save c'",
    );
  });

  it("no warning: every path saves after the mutation", () => {
    expect(warnings(`scheduled {\n    let c = load Customer("1")\n    c.comments = "Changed"\n    if c.email == "" {\n        save c\n    } else {\n        save c\n    }\n}\n`)).toEqual([]);
  });

  it("warning: a mutation after the last save still warns", () => {
    const w = warnings(`scheduled {\n    let c = load Customer("1")\n    c.comments = "A"\n    save c\n    c.comments = "B"\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.span.start.line).toBe(5);
    expect(w[0]!.message).toContain("modified after its last save");
  });

  it("no warning: a later unconditional save covers every path", () => {
    expect(warnings(`scheduled {\n    let c = load Customer("1")\n    c.comments = "A"\n    if c.email == "" {\n        save c\n    }\n    c.comments = "B"\n    save c\n}\n`)).toEqual([]);
  });

  it("warning: mutation in then, save only in else", () => {
    const w = warnings(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        c.comments = "x"\n    } else {\n        save c\n    }\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.span.start.line).toBe(4);
    expect(w[0]!.message).toContain("never saved");
  });

  it("no warning: a save inside a nested branch on the mutated path", () => {
    expect(warnings(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        c.comments = "x"\n        if c.comments == "x" {\n            save c\n        } else {\n            save c\n        }\n    }\n}\n`)).toEqual([]);
  });

  it("one warning per write, in source order, and none for context records in branches", () => {
    const w = warnings(
      `beforeSubmit edit (ctx: Customer) {\n    let c = load Customer("1")\n    if ctx.email == "" {\n        ctx.comments = "ok"\n        c.comments = "a"\n    } else {\n        c.email = "b"\n    }\n    if ctx.email == "" {\n        save c\n    }\n}\n`,
    );
    expect(w.map((d) => d.span.start.line)).toEqual([5, 7]);
    expect(w.every((d) => d.message.includes("not every execution path"))).toBe(true);
  });

  it("warnings do not block output", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        c.comments = "Missing"\n    }\n}\n`);
    expect(result.output).toContain("c.setValue(");
    expect(result.output).not.toContain(".save()");
  });
});

describe("logical operators, not, grouping, and Bool literals", () => {
  function conditionOf(source: string) {
    const result = compileSail(source);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const last = unit.entryPoint.body[unit.entryPoint.body.length - 1]!;
    if (last.kind !== "If") throw new Error();
    return last.condition;
  }
  const PRELUDE = `let c = load Customer("1")\n    let a = c.email == ""\n    let b = c.comments == ""\n`;

  it("binds Bool && Bool and Bool || Bool to Logical with type Bool", () => {
    expect(conditionOf(`scheduled {\n    ${PRELUDE}    if a && b { }\n}\n`)).toMatchObject({
      kind: "Logical",
      operation: "And",
      type: "Bool",
      left: { kind: "LocalReference", type: "Bool" },
      right: { kind: "LocalReference", type: "Bool" },
    });
    expect(conditionOf(`scheduled {\n    ${PRELUDE}    if a || b { }\n}\n`)).toMatchObject({ kind: "Logical", operation: "Or", type: "Bool" });
  });

  it("binds !Bool to Not", () => {
    expect(conditionOf(`scheduled {\n    ${PRELUDE}    if !a { }\n}\n`)).toMatchObject({ kind: "Not", type: "Bool", operand: { kind: "LocalReference" } });
  });

  it("binds a condition composed of several comparisons", () => {
    expect(conditionOf(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" || c.comments == "Blocked" { }\n}\n`)).toMatchObject({
      kind: "Logical",
      operation: "Or",
      left: { kind: "Comparison", operation: "Equal", operandType: "Text" },
      right: { kind: "Comparison", operation: "Equal", operandType: "Text" },
    });
  });

  it("a grouped expression keeps its type and structure", () => {
    expect(conditionOf(`scheduled {\n    ${PRELUDE}    if (a || b) && !(c.email == "x") { }\n}\n`)).toMatchObject({
      kind: "Logical",
      operation: "And",
      left: { kind: "Logical", operation: "Or" },
      right: { kind: "Not", operand: { kind: "Comparison" } },
    });
    expect(conditionOf(`scheduled {\n    ${PRELUDE}    if (c.email) == "" { }\n}\n`)).toMatchObject({ kind: "Comparison", left: { kind: "FieldRead" } });
  });

  it("binds true and false as Bool literals, in locals and conditions", () => {
    const result = compileSail(`scheduled {\n    let enabled = true\n    if enabled { }\n    if false { }\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    expect(unit.entryPoint.body[0]).toMatchObject({ kind: "LocalDeclaration", local: { type: "Bool" }, initializer: { kind: "BoolLiteral", value: true } });
    expect(unit.entryPoint.body[2]).toMatchObject({ kind: "If", condition: { kind: "BoolLiteral", value: false, type: "Bool" } });
  });

  it("SAIL1024 rejects non-Bool logical operands, one diagnostic per operand", () => {
    const left = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email && true { }\n}\n`);
    expect(errorCodes(left)).toEqual(["SAIL1024"]);
    expect(left.diagnostics[0]!.message).toBe(
      "operator '&&' requires Bool operands, but the left operand is Text. Sail has no truthiness: compare the value explicitly, for example with == or !=",
    );
    expect(left.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 8 });

    const both = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email || c.comments { }\n}\n`);
    expect(errorCodes(both)).toEqual(["SAIL1024", "SAIL1024"]);
    expect(both.diagnostics[1]!.message).toContain("the right operand is Text");

    const record = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c && true { }\n}\n`);
    expect(record.diagnostics[0]!.message).toContain("the left operand is Customer");
  });

  it("SAIL1024 rejects ! on a non-Bool", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if !c.email { }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1024"]);
    expect(result.diagnostics[0]!.message).toBe(
      "operator '!' requires Bool, but received Text. Sail has no truthiness: compare the value explicitly, for example with == or !=",
    );
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 9 });
  });

  it("SAIL1023 Bool equality is rejected with a hint to use the Bool directly", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    let a = c.email == ""\n    if a == true { }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1023"]);
    expect(result.diagnostics[0]!.message).toBe(
      "'==' is not defined for Bool values; comparisons are defined for Text and Number values. Use a Bool directly as a condition: 'if x' or 'if !x'",
    );
  });

  it("a grouped comparison chain fails type checking rather than parsing", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if (c.email == "") == c.comments { }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1022"]);
    expect(result.diagnostics[0]!.message).toBe("Cannot compare Bool with Text: both sides of '==' must have the same type");
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 3, column: 8 });
  });

  it("errors inside both operands of a logical expression are all reported", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.nope == "" || !c.nada { }\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1004", "SAIL1004"]);
  });
});

describe("emitter: precedence-aware parenthesization", () => {
  const PRELUDE = `let c = load Customer("1")\n    let a = c.email == ""\n    let b = c.comments == ""\n    let d = true\n`;
  function ifLine(condition: string): string {
    const result = compileSail(`scheduled {\n    ${PRELUDE}    if ${condition} { }\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const line = result.output!.split("\n").find((l) => l.trim().startsWith("if ("));
    return line!.trim();
  }

  it("adds parentheses only when precedence requires them", () => {
    expect(ifLine(`a || b && d`)).toBe("if (a || b && d) {");
    expect(ifLine(`(a || b) && d`)).toBe("if ((a || b) && d) {");
    expect(ifLine(`a && (b || d)`)).toBe("if (a && (b || d)) {");
    expect(ifLine(`(a && b) || d`)).toBe("if (a && b || d) {");
    expect(ifLine(`(a)`)).toBe("if (a) {");
  });

  it("keeps left-associative chains flat and explicit right grouping parenthesized", () => {
    expect(ifLine(`a || b || d`)).toBe("if (a || b || d) {");
    expect(ifLine(`(a || b) || d`)).toBe("if (a || b || d) {");
    expect(ifLine(`a || (b || d)`)).toBe("if (a || (b || d)) {");
  });

  it("parenthesizes a comparison under not", () => {
    const result = compileSail(`scheduled {\n    ${PRELUDE}    if !(c.email == "x") { }\n}\n`);
    expect(result.output).toContain(`!(\n                c.getValue({\n                    fieldId: "email"\n                }) === "x"\n            )`);
    expect(ifLine(`!a`)).toBe("if (!a) {");
    expect(ifLine(`!!a`)).toBe("if (!!a) {");
    expect(ifLine(`!(a && !(b || d))`)).toBe("if (!(a && !(b || d))) {");
    expect(ifLine(`!a || b`)).toBe("if (!a || b) {");
  });

  it("emits strict equality and Bool literals", () => {
    expect(ifLine(`false`)).toBe("if (false) {");
    expect(ifLine(`d || !d`)).toBe("if (d || !d) {");
    expect(ifLine(`c.email != "x"`)).toBe("if (");
    const strict = compileSail(`scheduled {\n    ${PRELUDE}    if c.email != "x" { }\n}\n`);
    expect(strict.output).toContain(`}) !== "x"`);
    const result = compileSail(`scheduled {\n    let enabled = true\n    if enabled { }\n}\n`);
    expect(result.output).toContain("const enabled = true;");
  });

  it("breaks long logical conditions after the operator", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" || c.comments == "Blocked" { }\n}\n`);
    expect(result.output).toContain(`}) === "" ||\n            c.getValue({`);
  });
});

describe("SAIL2001 is independent of condition structure", () => {
  function warnings(source: string) {
    const result = compileSail(source);
    expect(errorCodes(result)).toEqual([]);
    return result.diagnostics.filter((d) => d.severity === "warning");
  }

  it("a compound condition changes nothing about the mutated path", () => {
    expect(warnings(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" || c.comments == "Blocked" {\n        c.comments = "x"\n        save c\n    }\n}\n`)).toEqual([]);
    const w = warnings(`scheduled {\n    let c = load Customer("1")\n    if !(c.email == "") && (c.comments == "" || true) {\n        c.comments = "x"\n    }\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("never saved");
  });

  it("a constant condition is still a branch", () => {
    const w = warnings(`scheduled {\n    let c = load Customer("1")\n    c.comments = "x"\n    if true {\n        save c\n    }\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("not every execution path");
  });
});

describe("create", () => {
  it("binds create Customer to an owned Customer through the generic record-type call path", () => {
    const result = compileSail(`scheduled {\n    let customer = create Customer\n    save customer\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    expect(unit.entryPoint.body[0]).toMatchObject({
      kind: "LocalDeclaration",
      local: { name: "customer", type: { kind: "Record", origin: "owned", record: { name: "Customer" } } },
      initializer: {
        kind: "BuiltinCall",
        builtin: { id: "create", result: "new" },
        callee: { kind: "BuiltinReference", builtin: { id: "create" } },
        recordType: { kind: "RecordTypeReference", record: { id: "customer" } },
        arguments: [],
        type: { origin: "owned" },
      },
    });
    expect([...unit.dependencies]).toEqual(["N/record"]);
  });

  it("SAIL1001 unknown record type uses the existing did-you-mean diagnostic", () => {
    const result = compileSail(`scheduled {\n    let c = create Custmer\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1001"]);
    expect(result.diagnostics[0]!.message).toBe("Unknown record type 'Custmer'. Did you mean 'Customer'? Known record types: Customer, Invoice, SailLog, SalesOrder");
  });

  it("SAIL1006 and SAIL1013 for a missing type or stray arguments", () => {
    const bare = compileSail(`scheduled {\n    let c = create\n}\n`);
    expect(errorCodes(bare)).toEqual(["SAIL1006"]);
    expect(bare.diagnostics[0]!.message).toBe("'create' is a built-in function and must be called, like 'create Customer'");
    expect(compileSail(`scheduled {\n    let c = load\n}\n`).diagnostics[0]!.message).toContain("like 'load Customer(...)'");
    const args = compileSail(`scheduled {\n    let c = create Customer("1")\n}\n`);
    expect(errorCodes(args)).toEqual(["SAIL1013"]);
    expect(args.diagnostics[0]!.message).toBe("create expects 0 arguments, but received 1");
    expect(errorCodes(compileSail(`scheduled {\n    let c = load Customer\n}\n`))).toEqual(["SAIL1013"]);
  });

  it("creates a custom record through the same path", () => {
    const result = compileSail(`scheduled {\n    let entry = create SailLog\n    entry.custrecord_sail_message = "hi"\n    entry.custrecord_sail_done = true\n    save entry\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain('type: "customrecord_sail_log"');
  });

  it("writes on a created record use the ordinary field-write checks", () => {
    const ok = compileSail(`scheduled {\n    let c = create Customer\n    c.comments = "x"\n    save c\n}\n`);
    expect(ok.diagnostics).toEqual([]);
    expect(errorCodes(compileSail(`scheduled {\n    let c = create Customer\n    c.entityid = "x"\n    save c\n}\n`))).toEqual(["SAIL1005"]);
    expect(errorCodes(compileSail(`scheduled {\n    let c = create Customer\n    c.comments = 1\n    save c\n}\n`))).toEqual(["SAIL1006"]);
    expect(errorCodes(compileSail(`scheduled {\n    let c = create Customer\n    c.nope = "x"\n    save c\n}\n`))).toEqual(["SAIL1004"]);
  });

  it("an owned record may be written and saved in afterSubmit, while the context record may not", () => {
    const owned = compileSail(`afterSubmit edit (customer: Customer) {\n    let audit = create SailLog\n    audit.custrecord_sail_message = customer.email\n    save audit\n}\n`);
    expect(owned.diagnostics).toEqual([]);
    const context = compileSail(`afterSubmit edit (customer: Customer) {\n    customer.comments = "x"\n}\n`);
    expect(errorCodes(context)).toEqual(["SAIL1007"]);
    const before = compileSail(`beforeSubmit edit (customer: Customer) {\n    let entry = create SailLog\n    entry.custrecord_sail_message = customer.email\n    save entry\n}\n`);
    expect(before.diagnostics).toEqual([]);
    expect([...before.unit!.dependencies]).toEqual(["N/record"]);
  });

  it("origin is a capability: created and loaded records are both owned, context is not", () => {
    const result = compileSail(`beforeSubmit edit (ctx: Customer) {\n    let a = load Customer("1")\n    let b = create Customer\n    save a\n    save b\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const origins = result.unit!.symbols.map((s) => `${s.local.name}:${isRecordType(s.local.type) ? s.local.type.origin : "?"}`);
    expect(origins).toEqual(["ctx:context", "a:owned", "b:owned"]);
    expect(errorCodes(compileSail(`beforeSubmit edit (ctx: Customer) {\n    save ctx\n}\n`))).toEqual(["SAIL1020"]);
  });
});

describe("SAIL2001 for created records", () => {
  function warnings(source: string) {
    const result = compileSail(source);
    expect(errorCodes(result)).toEqual([]);
    return result.diagnostics.filter((d) => d.severity === "warning");
  }

  it("warns when a created record is never saved, even untouched", () => {
    const w = warnings(`scheduled {\n    let c = create Customer\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: "SAIL2001", span: { start: { line: 2, column: 5 } } });
    expect(w[0]!.message).toBe("'c' is created but never saved; a new Customer does not exist in NetSuite until you 'save c'");
  });

  it("warns once for a created, modified, never-saved record", () => {
    const w = warnings(`scheduled {\n    let c = create Customer\n    c.comments = "x"\n    c.email = "y"\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("is created but never saved");
  });

  it("does not warn when the created record is saved, modified or not", () => {
    expect(warnings(`scheduled {\n    let c = create Customer\n    c.comments = "x"\n    save c\n}\n`)).toEqual([]);
    expect(warnings(`scheduled {\n    let c = create Customer\n    save c\n}\n`)).toEqual([]);
  });

  it("warns about a change after the save of a created record", () => {
    const w = warnings(`scheduled {\n    let c = create Customer\n    save c\n    c.comments = "x"\n}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.span.start.line).toBe(4);
    expect(w[0]!.message).toContain("modified after its last save");
  });

  it("warns when only some paths save the created record, and not when all do", () => {
    const some = warnings(`scheduled {\n    let c = create Customer\n    if true {\n        save c\n    }\n}\n`);
    expect(some).toHaveLength(1);
    expect(some[0]!.message).toBe("'c' may leave this script unsaved: it is created here, but not every execution path that follows performs 'save c'");
    expect(warnings(`scheduled {\n    let c = create Customer\n    if true {\n        save c\n    } else {\n        save c\n    }\n}\n`)).toEqual([]);
  });

  it("a loaded record untouched and unsaved does not warn; a created one does", () => {
    expect(warnings(`scheduled {\n    let c = load Customer("1")\n}\n`)).toEqual([]);
    expect(warnings(`scheduled {\n    let a = load Customer("1")\n    let b = create Customer\n}\n`).map((d) => d.message)).toEqual([
      "'b' is created but never saved; a new Customer does not exist in NetSuite until you 'save b'",
    ]);
  });
});

describe("bound spans and expression table", () => {
  it("records field, callee, namespace, and record-type spans", () => {
    const source = `scheduled {\n    let c = load Customer("1")\n    c.comments = c.email\n    log.debug(c.email)\n    save c\n}\n`;
    const result = compileSail(source);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const [declaration, write, call] = unit.entryPoint.body;
    if (declaration?.kind !== "LocalDeclaration" || declaration.initializer.kind !== "BuiltinCall") throw new Error();
    expect(declaration.initializer.callee).toMatchObject({ kind: "BuiltinReference", nameSpan: { start: { line: 2, column: 13 }, end: { line: 2, column: 17 } }, namespaceSpan: undefined });
    expect(declaration.initializer.recordType).toMatchObject({ kind: "RecordTypeReference", span: { start: { line: 2, column: 18 }, end: { line: 2, column: 26 } } });
    if (write?.kind !== "FieldWrite" || write.value.kind !== "FieldRead") throw new Error();
    expect(write.fieldSpan).toMatchObject({ start: { line: 3, column: 7 }, end: { line: 3, column: 15 } });
    expect(write.value.fieldSpan).toMatchObject({ start: { line: 3, column: 20 }, end: { line: 3, column: 25 } });
    if (call?.kind !== "ExpressionStatement") throw new Error();
    expect(call.expression.callee).toMatchObject({
      span: { start: { line: 4, column: 5 }, end: { line: 4, column: 14 } },
      namespaceSpan: { start: { line: 4, column: 5 }, end: { line: 4, column: 8 } },
      nameSpan: { start: { line: 4, column: 9 }, end: { line: 4, column: 14 } },
    });
  });

  it("keeps every bound expression, including those in statements that failed", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    c.nope\n    load Customer("2").nope\n    log.debug(c.nope)\n}\n`);
    expect(errorCodes(result)).toEqual(["SAIL1004", "SAIL1004", "SAIL1004"]);
    const kinds = result.unit!.expressions.map((e) => `${e.kind}@${e.span.start.line}`);
    expect(kinds).toEqual([
      "StringLiteral@2", "BuiltinCall@2", "LocalReference@3", "StringLiteral@4", "BuiltinCall@4", "LocalReference@5",
    ]);
  });
});

describe("delete", () => {
  function errors(source: string) {
    const result = compileSail(source);
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
  }

  it("binds delete of a loaded record and needs no new dependency", () => {
    const result = compileSail(`scheduled {\n    let customer = load Customer("123")\n    delete customer\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    expect(unit.entryPoint.body[1]).toMatchObject({ kind: "DeleteRecord", target: { kind: "LocalReference", local: { name: "customer" } } });
    expect([...unit.dependencies]).toEqual(["N/record"]);
  });

  it("SAIL1026 rejects deleting a new record before it is saved, and allows it after", () => {
    expect(errors(`scheduled {\n    let c = create Customer\n    delete c\n}\n`)).toEqual([
      "SAIL1026 Cannot delete 'c' before it has been saved: a new Customer does not exist in NetSuite until you 'save c'",
    ]);
    expect(errors(`scheduled {\n    let c = create Customer\n    save c\n    delete c\n}\n`)).toEqual([]);
    expect(errors(`scheduled {\n    let c = copy Customer("1")\n    delete c\n}\n`)[0]).toContain("SAIL1026");
    expect(errors(`scheduled {\n    let i = transform SalesOrder("1") to Invoice\n    save i\n    delete i\n}\n`)).toEqual([]);
  });

  it("SAIL1026 rejects delete when the save is only conditional", () => {
    expect(errors(`scheduled {\n    let d = create Customer\n    if true {\n        save d\n    }\n    delete d\n}\n`)).toEqual([
      "SAIL1026 Cannot delete 'd': it may not have been saved on every path that reaches this delete",
    ]);
    expect(errors(`scheduled {\n    let d = create Customer\n    if true {\n        save d\n    } else {\n        save d\n    }\n    delete d\n}\n`)).toEqual([]);
  });

  it("SAIL1025 rejects deleting the context record or an unnamed record", () => {
    expect(errors(`beforeSubmit edit (customer: Customer) {\n    delete customer\n}\n`)).toEqual([
      "SAIL1025 'customer' is the Customer from beforeSubmit and cannot be deleted: it is NetSuite's record, not the script's. Only records the script loaded, created, copied, or transformed can be deleted",
    ]);
    expect(errors(`afterSubmit edit (customer: Customer) {\n    delete customer\n}\n`)[0]).toContain("from afterSubmit and cannot be deleted");
    expect(errors(`scheduled {\n    delete load Customer("3")\n}\n`)).toEqual([
      "SAIL1025 Delete a named record: declare it first, like 'let x = load Customer(...)', then 'delete x'",
    ]);
    expect(errors(`scheduled {\n    let e = "text"\n    delete e\n}\n`)).toEqual(["SAIL1019 'e' is a Text value and cannot be deleted. Only records can be deleted"]);
  });

  it("SAIL1028 rejects a double delete", () => {
    expect(errors(`scheduled {\n    let b = load Customer("1")\n    delete b\n    delete b\n}\n`)).toEqual(["SAIL1028 'b' has already been deleted"]);
    expect(errors(`scheduled {\n    let b = load Customer("1")\n    if true {\n        delete b\n    }\n    delete b\n}\n`)).toEqual([
      "SAIL1028 'b' may already have been deleted on this path",
    ]);
  });

  it("SAIL1027 a deleted record is consumed: no read, write, save, or other use", () => {
    expect(errors(`scheduled {\n    let b = load Customer("1")\n    delete b\n    b.comments = "x"\n    log.debug(b.email)\n    save b\n    if b.email == "" {\n    }\n}\n`)).toEqual([
      "SAIL1027 Cannot assign Customer.comments because 'b' has been deleted",
      "SAIL1027 Cannot read field 'email' because 'b' has been deleted",
      "SAIL1027 Cannot save 'b' after it has been deleted",
      "SAIL1027 Cannot read field 'email' because 'b' has been deleted",
    ]);
    const result = compileSail(`scheduled {\n    let b = load Customer("1")\n    delete b\n    b.comments = "x"\n}\n`);
    expect(result.diagnostics[0]!.span.start).toMatchObject({ line: 4, column: 5 });
    expect(result.diagnostics[0]!.span.end).toMatchObject({ line: 4, column: 6 });
    expect(result.output).toBeUndefined();
  });

  it("conditional deletion makes later use unsafe, while use inside the other branch stays valid", () => {
    expect(errors(`scheduled {\n    let c = load Customer("2")\n    if c.email == "" {\n        delete c\n    } else {\n        c.comments = "kept"\n        save c\n    }\n    c.comments = "y"\n}\n`)).toEqual([
      "SAIL1027 Cannot assign Customer.comments because 'c' may already have been deleted on this path",
    ]);
    expect(errors(`scheduled {\n    let c = load Customer("2")\n    if c.email == "" {\n        delete c\n    } else {\n        delete c\n    }\n    log.debug(c.email)\n}\n`)).toEqual([
      "SAIL1027 Cannot read field 'email' because 'c' has been deleted",
    ]);
    expect(errors(`scheduled {\n    let c = load Customer("2")\n    if c.email == "" {\n        c.comments = "a"\n        save c\n    } else {\n        delete c\n    }\n}\n`)).toEqual([]);
  });

  it("deletion silences unsaved-write warnings for that record and reaches custom records", () => {
    const result = compileSail(`scheduled {\n    let c = load Customer("1")\n    c.comments = "x"\n    delete c\n    let entry = load SailLog("7")\n    delete entry\n}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain('type: "customrecord_sail_log",\n            id: entry.id');
  });

  it("copy and transform are new owned records of the right type", () => {
    const result = compileSail(
      `scheduled {\n    let dup = copy Customer("1")\n    let inv = transform SalesOrder("55") to Invoice\n    inv.memo = dup.email\n    save dup\n    save inv\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    expect(unit.entryPoint.body[0]).toMatchObject({ local: { type: { record: { name: "Customer" }, origin: "owned" } }, initializer: { builtin: { id: "copy", result: "new" } } });
    expect(unit.entryPoint.body[1]).toMatchObject({
      local: { type: { record: { name: "Invoice" }, origin: "owned" } },
      initializer: {
        builtin: { id: "transform", returns: "target", result: "new" },
        recordType: { record: { name: "SalesOrder" } },
        targetType: { kind: "RecordTypeReference", record: { name: "Invoice" } },
      },
    });
    expect([...unit.dependencies]).toEqual(["N/record"]);
  });

  it("copy and transform warn when never saved, through the same path as create", () => {
    const w = compileSail(`scheduled {\n    let dup = copy Customer("1")\n    let inv = transform SalesOrder("55") to Invoice\n}\n`).diagnostics;
    expect(w.map((d) => d.message)).toEqual([
      "'dup' is created but never saved; a new Customer does not exist in NetSuite until you 'save dup'",
      "'inv' is created but never saved; a new Invoice does not exist in NetSuite until you 'save inv'",
    ]);
    expect(compileSail(`scheduled {\n    let inv = transform SalesOrder("55") to Invoice\n    save inv\n}\n`).diagnostics).toEqual([]);
  });

  it("SAIL1018 and SAIL1001 for transform's record types", () => {
    expect(errors(`scheduled {\n    let f = transform SalesOrder("1")\n}\n`)).toEqual([
      "SAIL1018 transform expects a target record type after the arguments, like transform SalesOrder(...) to Invoice",
    ]);
    expect(errors(`scheduled {\n    let g = load SalesOrder("1") to Invoice\n}\n`)).toEqual(["SAIL1018 load does not take a target record type; remove 'to Invoice'"]);
    expect(errors(`scheduled {\n    let h = transform SalesOrder("1") to Nope\n}\n`)[0]).toContain("SAIL1001 Unknown record type 'Nope'");
    expect(errors(`scheduled {\n    let h = transform Nope("1") to Invoice\n}\n`)[0]).toContain("SAIL1001 Unknown record type 'Nope'");
    // Compatibility is not checked: NetSuite decides at runtime.
    expect(errors(`scheduled {\n    let odd = transform Customer("1") to SailLog\n    save odd\n}\n`)).toEqual([]);
  });
});

describe("query", () => {
  function errors(source: string) {
    return compileSail(source).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
  }

  it("binds query Customer to a Sequence<Customer> with a backend-neutral predicate and infers N/query", () => {
    const result = compileSail(`scheduled {\n    let customers = query Customer\n        where email != "" && comments == "vip"\n    for customer in customers {\n        log.debug(customer.email)\n    }\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const [declaration, loop] = unit.entryPoint.body;
    expect(declaration).toMatchObject({
      local: { name: "customers", type: { kind: "Sequence", element: { kind: "Record", origin: "query", record: { name: "Customer" } } } },
      initializer: {
        kind: "Query",
        recordType: { kind: "RecordTypeReference", record: { name: "Customer" } },
        condition: { kind: "Logical", operation: "And", left: { kind: "Comparison", left: { kind: "QueryField", field: { id: "email" } } } },
        predicate: {
          kind: "And",
          left: { kind: "Compare", field: { id: "email" }, operation: "NotEqual", value: { kind: "Constant", value: "" } },
          right: { kind: "Compare", field: { id: "comments" }, operation: "Equal", value: { kind: "Constant", value: "vip" } },
        },
      },
    });
    expect(loop).toMatchObject({
      kind: "ForEach",
      local: { name: "customer", origin: "loop", type: { origin: "query", record: { name: "Customer" } } },
      iterable: { kind: "LocalReference", local: { name: "customers" } },
      body: [{ kind: "ExpressionStatement", expression: { arguments: [{ kind: "FieldRead", receiver: { local: { name: "customer" } }, type: "Text" }] } }],
    });
    expect([...unit.dependencies].sort()).toEqual(["N/log", "N/query"]);
    expect(typeName(declaration!.kind === "LocalDeclaration" ? declaration.local.type : "Void")).toBe("Sequence<Customer>");
  });

  it("supports Bool flags, negation, flipped comparisons, numbers, and captured locals", () => {
    const result = compileSail(
      `scheduled {\n    let wanted = "x"\n    let logs = query SailLog where custrecord_sail_done && !(name == wanted)\n    let orders = query SalesOrder where 100 < total\n    for l in logs { }\n    for o in orders { }\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    expect(unit.entryPoint.body[1]).toMatchObject({
      initializer: {
        predicate: {
          kind: "And",
          left: { kind: "Flag", field: { id: "custrecord_sail_done" }, value: true },
          right: { kind: "Not", operand: { kind: "Compare", field: { id: "name" }, operation: "Equal", value: { kind: "Local", local: { name: "wanted" } } } },
        },
      },
    });
    expect(unit.entryPoint.body[2]).toMatchObject({ initializer: { predicate: { kind: "Compare", field: { id: "total" }, operation: "Greater", value: { value: 100 } } } });
  });

  it("resolves bare names in where as fields of the queried record, with field diagnostics", () => {
    expect(errors(`scheduled {\n    let a = query Customer where nonexistent == "x"\n}\n`)).toEqual(["SAIL1004 Customer has no field 'nonexistent'"]);
    expect(errors(`scheduled {\n    let a = query Customer where emial == "x"\n}\n`)).toEqual(["SAIL1004 Customer has no field 'emial'. Did you mean 'email'?"]);
    expect(errors(`scheduled {\n    let a = query Nope where email == "x"\n}\n`)[0]).toContain("SAIL1001 Unknown record type 'Nope'");
  });

  it("rejects non-Bool, field-vs-field, and non-field conditions, and ambiguous names", () => {
    expect(errors(`scheduled {\n    let a = query Customer where comments\n}\n`)).toEqual([
      `SAIL1021 where condition must be Bool, but received Text. Compare a field, for example 'where email != ""'`,
    ]);
    expect(errors(`scheduled {\n    let a = query Customer where comments == entityid\n}\n`)).toEqual([
      "SAIL1031 Unsupported query condition: a field can be compared with a value, not with another field",
    ]);
    expect(errors(`beforeSubmit edit (ctx: Customer) {\n    let a = query Customer where ctx.email == "x"\n}\n`)).toEqual([
      "SAIL1031 Unsupported query condition: one side of the comparison must be a field of the queried record",
    ]);
    expect(errors(`scheduled {\n    let email = "dup"\n    let a = query Customer where email == "x"\n}\n`)).toEqual([
      "SAIL1032 'email' is both a field of Customer and a local in scope; inside 'where' a bare name is the field. Rename the local to use it here",
    ]);
    expect(errors(`scheduled {\n    let flag = true\n    let a = query Customer where flag\n}\n`)[0]).toContain("SAIL1031");
  });

  it("query rows are read-only views with an id, and loading by id yields an owned record", () => {
    const ok = compileSail(`scheduled {\n    for row in query Customer {\n        let loaded = load Customer(row.id)\n        loaded.comments = row.email\n        save loaded\n    }\n}\n`);
    expect(ok.diagnostics).toEqual([]);
    const unit = ok.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const loop = unit.entryPoint.body[0]!;
    if (loop.kind !== "ForEach") throw new Error();
    expect(loop.iterable.kind).toBe("Query");
    expect(loop.body[0]).toMatchObject({ initializer: { arguments: [{ kind: "RecordIdRead", type: "Text" }] }, local: { type: { origin: "owned" } } });

    expect(errors(`scheduled {\n    for row in query Customer {\n        row.comments = "x"\n    }\n}\n`)).toEqual([
      "SAIL1030 Query result 'row' is read-only. Load the record before modifying it: 'let x = load Customer(row.id)', then assign 'x.comments'",
    ]);
    expect(errors(`scheduled {\n    for row in query Customer {\n        save row\n    }\n}\n`)).toEqual([
      "SAIL1030 Query result 'row' cannot be saved: a query row is a read-only view. Load the record first: 'let x = load Customer(row.id)', then 'save x'",
    ]);
    expect(errors(`scheduled {\n    for row in query Customer {\n        delete row\n    }\n}\n`)[0]).toContain("cannot be deleted: a query row is a read-only view");
    expect(errors(`scheduled {\n    for row in query Customer {\n        log.debug(row.nope)\n    }\n}\n`)).toEqual(["SAIL1004 Customer has no field 'nope'"]);
    expect(errors(`scheduled {\n    let c = load Customer("1")\n    log.debug(c.id)\n}\n`)).toEqual(["SAIL1004 Customer has no field 'id'"]);
  });

  it("the loop variable is scoped to the body and cannot shadow", () => {
    expect(errors(`scheduled {\n    for row in query Customer { }\n    log.debug(row.email)\n}\n`)[0]).toContain("SAIL1010 Unknown identifier 'row'");
    expect(errors(`beforeSubmit edit (ctx: Customer) {\n    for ctx in query Customer { }\n}\n`)).toEqual([
      "SAIL1017 'ctx' is already declared in an enclosing scope as the entry point parameter (line 1)",
    ]);
    expect(errors(`scheduled {\n    for a in query Customer { }\n    for a in query SalesOrder { }\n}\n`)).toEqual([]);
    expect(errors(`scheduled {\n    let c = load Customer("1")\n    for x in c { }\n    for y in "text" { }\n}\n`)).toEqual([
      "SAIL1029 Cannot iterate over a Customer value; 'for' needs a query result, like 'for x in query Customer'",
      "SAIL1029 Cannot iterate over a Text value; 'for' needs a query result, like 'for x in query Customer'",
    ]);
  });
});

describe("lifecycle analysis across loops", () => {
  function diagnostics(source: string) {
    return compileSail(source).diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`);
  }

  it("a loop runs zero or more times: an unsaved create inside warns once, a saved one does not", () => {
    expect(diagnostics(`scheduled {\n    for row in query Customer {\n        let c = create Customer\n        c.email = row.email\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'c' is created but never saved; a new Customer does not exist in NetSuite until you 'save c'",
    ]);
    expect(diagnostics(`scheduled {\n    for row in query Customer {\n        let c = create Customer\n        c.email = row.email\n        save c\n    }\n}\n`)).toEqual([]);
  });

  it("write + save inside the loop on an outer record does not warn; write without save does", () => {
    expect(diagnostics(`scheduled {\n    let customer = load Customer("1")\n    for row in query Customer {\n        customer.comments = row.email\n        save customer\n    }\n}\n`)).toEqual([]);
    expect(diagnostics(`scheduled {\n    let customer = load Customer("1")\n    for row in query Customer {\n        customer.comments = row.email\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'customer' is modified but never saved; changes to a loaded Customer are discarded unless you 'save customer'",
    ]);
  });

  it("conditional delete inside a loop leaves the record possibly deleted after it, and on the next iteration", () => {
    expect(diagnostics(`scheduled {\n    let customer = load Customer("1")\n    for row in query SailLog {\n        if row.custrecord_sail_done {\n            delete customer\n        }\n    }\n    customer.comments = "x"\n}\n`)).toEqual([
      "error SAIL1028 'customer' may already have been deleted on this path",
      "error SAIL1027 Cannot assign Customer.comments because 'customer' may already have been deleted on this path",
    ]);
    expect(diagnostics(`scheduled {\n    let customer = load Customer("1")\n    for row in query SailLog {\n        log.debug(row.name)\n    }\n    delete customer\n}\n`)).toEqual([]);
  });

  it("a save inside the loop does not count as covering a write before the loop", () => {
    expect(diagnostics(`scheduled {\n    let customer = load Customer("1")\n    customer.comments = "x"\n    for row in query SailLog {\n        save customer\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'customer' may leave this script with unsaved changes: it is modified here, but not every execution path that follows performs 'save customer'",
    ]);
  });
});

describe("sublists", () => {
  function errors(source: string) {
    return compileSail(source).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
  }

  it("the schema provider exposes sublists with their own field objects", () => {
    const order = schema.getRecordByName("SalesOrder")!;
    expect([...order.sublists.keys()]).toEqual(["item"]);
    const item = order.sublists.get("item")!;
    expect(item.label).toBe("Items");
    expect([...item.fields.keys()]).toEqual(["item", "quantity", "rate", "amount", "description"]);
    expect(item.fields.get("amount")!.writable).toBe(false);
    expect(item.fields.get("item")).not.toBe(order.fields.get("item"));
    expect(schema.getRecordByName("Customer")!.sublists.size).toBe(0);
  });

  it("binds order.item as a Sublist and the loop variable as a Line with reads and writes through the parent", () => {
    const result = compileSail(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        log.debug(line.description)\n        line.quantity = 2\n    }\n    save order\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const loop = unit.entryPoint.body[1]!;
    if (loop.kind !== "ForEach") throw new Error();
    expect(loop.iterable).toMatchObject({ kind: "SublistAccess", receiver: { local: { name: "order" } }, sublist: { id: "item" }, type: { kind: "Sublist" } });
    expect(typeName(loop.iterable.type)).toBe("Sublist<SalesOrder.item>");
    expect(typeName(loop.local.type)).toBe("Line<SalesOrder.item>");
    expect(loop.local).toMatchObject({ origin: "loop", type: { kind: "Line", parent: { record: { name: "SalesOrder" }, origin: "owned" } } });
    expect(loop.body[0]).toMatchObject({ expression: { arguments: [{ kind: "FieldRead", receiver: { local: { name: "line" } }, field: { id: "description" }, type: "Text" }] } });
    expect(loop.body[1]).toMatchObject({ kind: "FieldWrite", receiver: { local: { name: "line" } }, field: { id: "quantity" }, value: { value: 2 } });
    expect([...unit.dependencies].sort()).toEqual(["N/log", "N/record"]);
  });

  it("rejects unknown sublists and line fields with did-you-mean, read-only and mistyped writes", () => {
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.itme { }\n}\n`)).toEqual(["SAIL1004 SalesOrder has no field or sublist 'itme'. Did you mean 'item'?"]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        log.debug(line.quantty)\n    }\n}\n`)).toEqual(["SAIL1004 SalesOrder.item has no field 'quantty'. Did you mean 'quantity'?"]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        line.amount = 1\n    }\n    save order\n}\n`)).toEqual(["SAIL1005 SalesOrder.item.amount is read-only and cannot be assigned"]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        line.quantity = "x"\n    }\n    save order\n}\n`)).toEqual(["SAIL1006 Cannot assign Text to SalesOrder.item.quantity, which is Number"]);
    expect(errors(`scheduled {\n    let c = load Customer("1")\n    for line in c.item { }\n}\n`)).toEqual(["SAIL1004 Customer has no field 'item'"]);
  });

  it("query rows have no sublists, and a sublist is not a value", () => {
    expect(errors(`scheduled {\n    for row in query SalesOrder {\n        for line in row.item { }\n    }\n}\n`)).toEqual([
      "SAIL1034 Sublist 'item' is available only on a loaded or context SalesOrder; a query row has no lines. Load the record first: 'let x = load SalesOrder(row.id)', then 'for line in x.item'",
    ]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    let x = order.item\n}\n`)).toEqual(["SAIL1006 A sublist cannot be stored in a local; iterate it where it is: 'for line in order.item'"]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    log.debug(order.item.quantity)\n}\n`)).toEqual([
      "SAIL1011 Cannot access '.quantity' on a sublist; iterate its lines: 'for line in order.item', then use 'line.quantity'",
    ]);
    expect(errors(`scheduled {\n    for line in load SalesOrder("2").item { }\n}\n`)).toEqual([
      "SAIL1029 Iterate the sublist of a named record: declare it first, like 'let x = load SalesOrder(...)', then 'for line in x.item'",
    ]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order { }\n}\n`)[0]).toContain("'for' needs a sublist of it, like 'for line in order.item'");
  });

  it("a line cannot be saved or deleted, and cannot be passed as a value", () => {
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        save line\n    }\n}\n`)).toEqual([
      "SAIL1033 A sublist line cannot be saved independently: 'line' is a line of SalesOrder.item, persisted with its parent. Save the parent SalesOrder instead",
    ]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        delete line\n    }\n}\n`)[0]).toContain("SAIL1033 A sublist line cannot be deleted independently");
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        log.debug(line)\n    }\n}\n`)).toEqual(["SAIL1014 log.debug argument 1 must be Text, but received Line<SalesOrder.item>"]);
    expect(errors(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item { }\n    log.debug(line.description)\n}\n`)[0]).toContain("SAIL1010 Unknown identifier 'line'");
  });

  it("context records govern line writes by hook, and copy or transform results have sublists", () => {
    expect(errors(`beforeSubmit edit (order: SalesOrder) {\n    for line in order.item {\n        line.quantity = 1\n    }\n}\n`)).toEqual([]);
    expect(errors(`afterSubmit edit (order: SalesOrder) {\n    for line in order.item {\n        line.quantity = 1\n    }\n}\n`)).toEqual([
      "SAIL1007 Cannot assign SalesOrder.item.quantity in afterSubmit: the SalesOrder is already saved and the change would be silently discarded. Use beforeSubmit instead.",
    ]);
    expect(errors(`afterSubmit edit (order: SalesOrder) {\n    for line in order.item {\n        log.debug(line.description)\n    }\n}\n`)).toEqual([]);
    expect(compileSail(`scheduled {\n    let inv = transform SalesOrder("1") to Invoice\n    for line in inv.item {\n        line.description = "x"\n    }\n    save inv\n}\n`).diagnostics).toEqual([]);
    expect(compileSail(`scheduled {\n    let dup = copy SalesOrder("1")\n    for line in dup.item {\n        line.rate = 5\n    }\n    save dup\n}\n`).diagnostics).toEqual([]);
    expect(compileSail(`scheduled {\n    let fresh = create SalesOrder\n    for line in fresh.item {\n        line.rate = 5\n    }\n    save fresh\n}\n`).diagnostics).toEqual([]);
  });
});

describe("lifecycle analysis with sublists", () => {
  function diagnostics(source: string) {
    return compileSail(source).diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`);
  }

  it("a line write is a pending write on the parent, cleared by saving the parent", () => {
    expect(diagnostics(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        line.quantity = 2\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified but never saved; changes to a loaded SalesOrder are discarded unless you 'save order'",
    ]);
    expect(diagnostics(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        line.quantity = 2\n    }\n    save order\n}\n`)).toEqual([]);
    expect(diagnostics(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        if line.quantity < 1 {\n            line.quantity = 1\n        }\n    }\n    save order\n}\n`)).toEqual([]);
  });

  it("a line write after the parent's last save warns, and a conditional save inside the loop is conservative", () => {
    expect(diagnostics(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        line.quantity = 2\n    }\n    save order\n    for line in order.item {\n        line.quantity = 3\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified after its last save; this change to the loaded SalesOrder is discarded unless you 'save order' again",
    ]);
    expect(diagnostics(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        line.quantity = 1\n        if line.rate > 10 {\n            save order\n        }\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'order' may leave this script with unsaved changes: it is modified here, but not every execution path that follows performs 'save order'",
    ]);
  });

  it("a deleted parent makes its sublist and lines unusable", () => {
    expect(diagnostics(`scheduled {\n    let order = load SalesOrder("1")\n    delete order\n    for line in order.item { }\n}\n`)).toEqual([
      "error SAIL1027 Cannot access sublist 'item' because 'order' has been deleted",
    ]);
    expect(diagnostics(`scheduled {\n    let order = load SalesOrder("1")\n    for line in order.item {\n        delete order\n        line.quantity = 1\n    }\n}\n`)).toEqual([
      "error SAIL1028 'order' may already have been deleted on this path",
      "error SAIL1027 Cannot assign SalesOrder.item.quantity because 'order' has been deleted",
    ]);
  });

  it("nested query and sublist loops converge and warn once", () => {
    expect(diagnostics(`scheduled {\n    for row in query SalesOrder {\n        let order = load SalesOrder(row.id)\n        for line in order.item {\n            line.quantity = 1\n        }\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified but never saved; changes to a loaded SalesOrder are discarded unless you 'save order'",
    ]);
    expect(diagnostics(`scheduled {\n    for row in query SalesOrder {\n        let order = load SalesOrder(row.id)\n        for line in order.item {\n            line.quantity = 1\n        }\n        save order\n    }\n}\n`)).toEqual([]);
  });
});

describe("add and remove lines", () => {
  function errors(source: string) {
    return compileSail(source).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
  }
  const ORDER = `scheduled {\n    let order = load SalesOrder("1")\n`;

  it("binds remove to the line's binding and add to initializers on the parent", () => {
    const result = compileSail(`${ORDER}    for line in order.item {\n        if line.quantity == 0 {\n            remove line\n        }\n    }\n    add order.item {\n        item = "100"\n        quantity = 2\n    }\n    save order\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    if (unit.kind !== "Scheduled") throw new Error();
    const [, loop, add] = unit.entryPoint.body;
    if (loop?.kind !== "ForEach" || !loop.line) throw new Error();
    expect(loop.line).toMatchObject({ line: { name: "line" }, parent: { name: "order" }, sublist: { id: "item" } });
    expect(unit.lineBindings.get(loop.local)).toBe(loop.line);
    const branch = loop.body[0]!;
    if (branch.kind !== "If") throw new Error();
    expect(branch.thenBody[0]).toMatchObject({ kind: "RemoveLine", line: { local: { name: "line" } }, binding: loop.line });
    expect(add).toMatchObject({
      kind: "AddLine",
      parent: { name: "order" },
      target: { kind: "SublistAccess", sublist: { id: "item" } },
      initializers: [
        { kind: "LineInitializer", field: { id: "item" }, value: { value: "100" } },
        { kind: "LineInitializer", field: { id: "quantity" }, value: { value: 2 } },
      ],
    });
  });

  it("rejects remove of non-lines and add to non-sublists or unnamed records", () => {
    expect(errors(`${ORDER}    remove order\n}\n`)).toEqual(["SAIL1019 'order' is a SalesOrder value and cannot be removed. Only a sublist line from a 'for' loop can be removed"]);
    expect(errors(`${ORDER}    add order.memo { quantity = 1 }\n}\n`)).toEqual(["SAIL1011 Cannot add a line to a Text value; 'add' needs a sublist, like 'add order.item { ... }'."]);
    expect(errors(`${ORDER}    add order { quantity = 1 }\n}\n`)).toEqual([
      "SAIL1011 Cannot add a line to a SalesOrder value; 'add' needs a sublist, like 'add order.item { ... }'. Name a sublist, like 'add order.item {'",
    ]);
    expect(errors(`${ORDER}    add order.itme { quantity = 1 }\n}\n`)).toEqual(["SAIL1004 SalesOrder has no field or sublist 'itme'. Did you mean 'item'?"]);
    expect(errors(`scheduled {\n    add load SalesOrder("3").item { quantity = 1 }\n}\n`)).toEqual([
      "SAIL1029 Add lines to the sublist of a named record: declare it first, like 'let x = load SalesOrder(...)', then 'add x.item {'",
    ]);
    expect(errors(`scheduled {\n    for row in query SalesOrder {\n        add row.item { quantity = 1 }\n    }\n}\n`)[0]).toContain("SAIL1034");
  });

  it("checks initializers: unknown, read-only, mistyped, duplicate, and non-initializer statements", () => {
    expect(errors(`${ORDER}    add order.item {\n        quantty = 1\n    }\n    save order\n}\n`)).toEqual(["SAIL1004 SalesOrder.item has no field 'quantty'. Did you mean 'quantity'?"]);
    expect(errors(`${ORDER}    add order.item {\n        amount = 5\n    }\n    save order\n}\n`)).toEqual(["SAIL1005 SalesOrder.item.amount is read-only and cannot be initialized"]);
    expect(errors(`${ORDER}    add order.item {\n        quantity = "x"\n    }\n    save order\n}\n`)).toEqual(["SAIL1006 Cannot assign Text to SalesOrder.item.quantity, which is Number"]);
    expect(errors(`${ORDER}    add order.item {\n        rate = 1\n        rate = 2\n    }\n    save order\n}\n`)).toEqual([
      "SAIL1035 SalesOrder.item.rate is initialized twice in this add block (first on line 4); a new line takes one value per field",
    ]);
    expect(errors(`${ORDER}    add order.item {\n        log.debug("no")\n        if true { }\n        order.memo = "x"\n    }\n    save order\n}\n`)).toEqual([
      "SAIL1035 An add block contains only field initializers, like 'quantity = 2'",
      "SAIL1035 An add block contains only field initializers, like 'quantity = 2'",
      "SAIL1035 An add block contains only field initializers, like 'quantity = 2'",
    ]);
    // Values are ordinary expressions in the enclosing scope, so a local named like a field is just the local.
    expect(errors(`scheduled {\n    let quantity = 3\n    let order = create SalesOrder\n    add order.item {\n        quantity = quantity\n    }\n    save order\n}\n`)).toEqual([]);
  });

  it("one rule governs writes: afterSubmit refuses add and remove, beforeSubmit allows them", () => {
    expect(errors(`afterSubmit edit (order: SalesOrder) {\n    for line in order.item {\n        remove line\n    }\n    add order.item { quantity = 1 }\n}\n`)).toEqual([
      "SAIL1007 Cannot remove a line from SalesOrder.item in afterSubmit: the SalesOrder is already saved and the change would be silently discarded. Use beforeSubmit instead.",
      "SAIL1007 Cannot add a line to SalesOrder.item in afterSubmit: the SalesOrder is already saved and the change would be silently discarded. Use beforeSubmit instead.",
    ]);
    expect(errors(`afterSubmit edit (customer: Customer) {\n    customer.comments = "x"\n}\n`)).toEqual([
      "SAIL1007 Cannot assign Customer.comments in afterSubmit: the Customer is already saved and the change would be silently discarded. Use beforeSubmit instead.",
    ]);
    expect(errors(`beforeSubmit edit (order: SalesOrder) {\n    for line in order.item {\n        if line.quantity == 0 {\n            remove line\n        }\n    }\n    add order.item { quantity = 1 }\n}\n`)).toEqual([]);
  });

  it("create, copy, and transform results accept add and remove with no special handling", () => {
    expect(compileSail(`scheduled {\n    let order = create SalesOrder\n    add order.item {\n        item = "123"\n        quantity = 2\n    }\n    save order\n}\n`).diagnostics).toEqual([]);
    expect(compileSail(`scheduled {\n    let order = copy SalesOrder("123")\n    add order.item {\n        item = "456"\n    }\n    save order\n}\n`).diagnostics).toEqual([]);
    expect(compileSail(`scheduled {\n    let invoice = transform SalesOrder("123") to Invoice\n    for line in invoice.item {\n        if line.quantity == 0 {\n            remove line\n        }\n    }\n    save invoice\n}\n`).diagnostics).toEqual([]);
  });

  it("SAIL1038 refuses adding to a sublist while iterating it, but not another sublist or record", () => {
    expect(errors(`${ORDER}    for line in order.item {\n        add order.item { quantity = 1 }\n    }\n    save order\n}\n`)).toEqual([
      "SAIL1038 Cannot add a line to SalesOrder.item while iterating it; add lines after the loop",
    ]);
    expect(errors(`${ORDER}    let other = load SalesOrder("2")\n    for line in order.item {\n        add other.item { quantity = line.quantity }\n    }\n    save order\n    save other\n}\n`)).toEqual([]);
  });
});

describe("lifecycle analysis with add and remove", () => {
  function diagnostics(source: string) {
    return compileSail(source).diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`);
  }
  const ORDER = `scheduled {\n    let order = load SalesOrder("1")\n`;

  it("remove and add are mutations of the parent, cleared by saving it", () => {
    expect(diagnostics(`${ORDER}    for line in order.item {\n        remove line\n    }\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified but never saved; changes to a loaded SalesOrder are discarded unless you 'save order'",
    ]);
    expect(diagnostics(`${ORDER}    add order.item { quantity = 1 }\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified but never saved; changes to a loaded SalesOrder are discarded unless you 'save order'",
    ]);
    expect(diagnostics(`${ORDER}    for line in order.item {\n        remove line\n    }\n    add order.item { quantity = 1 }\n    save order\n}\n`)).toEqual([]);
    expect(diagnostics(`${ORDER}    save order\n    add order.item { quantity = 1 }\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified after its last save; this change to the loaded SalesOrder is discarded unless you 'save order' again",
    ]);
    expect(diagnostics(`scheduled {\n    let order = create SalesOrder\n    add order.item { quantity = 1 }\n    save order\n}\n`)).toEqual([]);
  });

  it("a removed line is consumed: reads, writes, and a second remove are errors, with may/has wording", () => {
    expect(diagnostics(`${ORDER}    for line in order.item {\n        remove line\n        log.debug(line.description)\n        line.quantity = 2\n        remove line\n    }\n    save order\n}\n`)).toEqual([
      "error SAIL1036 Cannot read field 'description': this SalesOrder.item line has been removed",
      "error SAIL1036 Cannot assign SalesOrder.item.quantity: this SalesOrder.item line has been removed",
      "error SAIL1037 This SalesOrder.item line has already been removed",
    ]);
    expect(diagnostics(`${ORDER}    for line in order.item {\n        if line.quantity == 0 {\n            remove line\n        }\n        log.debug(line.description)\n    }\n    save order\n}\n`)).toEqual([
      "error SAIL1036 Cannot read field 'description': this SalesOrder.item line may already have been removed on this path",
    ]);
    expect(diagnostics(`${ORDER}    for line in order.item {\n        if line.quantity == 0 {\n            remove line\n        } else {\n            remove line\n        }\n        log.debug(line.description)\n    }\n    save order\n}\n`)).toEqual([
      "error SAIL1036 Cannot read field 'description': this SalesOrder.item line has been removed",
    ]);
  });

  it("each iteration is a fresh line, so a loop that removes lines is sound across iterations", () => {
    expect(diagnostics(`${ORDER}    for line in order.item {\n        if line.quantity == 0 {\n            remove line\n        }\n    }\n    for line in order.item {\n        log.debug(line.description)\n    }\n    save order\n}\n`)).toEqual([]);
    expect(diagnostics(`${ORDER}    for line in order.item {\n        log.debug(line.description)\n        if line.quantity == 0 {\n            remove line\n        }\n        if line.rate == 0 {\n            remove line\n        }\n    }\n    save order\n}\n`)).toEqual([
      "error SAIL1036 Cannot read field 'rate': this SalesOrder.item line may already have been removed on this path",
      "error SAIL1037 This SalesOrder.item line may already have been removed on this path",
    ]);
  });
});

describe("functions", () => {
  function errors(source: string) {
    return compileSail(source).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
  }

  it("binds functions, parameters with origin parameter, calls before declaration, and returns", () => {
    const result = compileSail(`scheduled {\n    let order = load SalesOrder("1")\n    setMemo(order, "x")\n    if isEmpty(order.memo) {\n        save order\n    }\n    save order\n}\nfn setMemo(order: SalesOrder, memo: Text) {\n    order.memo = memo\n}\nfn isEmpty(text: Text) -> Bool {\n    return text == ""\n}\n`);
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    expect(unit.functions.map((f) => `${f.name}:${f.returnType}`)).toEqual(["setMemo:Void", "isEmpty:Bool"]);
    const setMemo = unit.functions[0]!;
    expect(setMemo.parameters[0]).toMatchObject({ name: "order", origin: "parameter", type: { kind: "Record", origin: "parameter", record: { name: "SalesOrder" } } });
    expect(setMemo.body[0]).toMatchObject({ kind: "FieldWrite", receiver: { local: setMemo.parameters[0] } });
    if (unit.kind !== "Scheduled") throw new Error();
    expect(unit.entryPoint.body[1]).toMatchObject({
      kind: "ExpressionStatement",
      expression: { kind: "FunctionCall", function: setMemo, callee: { kind: "FunctionReference", function: setMemo }, type: "Void", arguments: [{ kind: "LocalReference" }, { value: "x" }] },
    });
    expect(unit.entryPoint.body[2]).toMatchObject({ kind: "If", condition: { kind: "FunctionCall", type: "Bool" } });
    expect(unit.symbols.map((s) => s.local.name)).toEqual(["order", "memo", "text", "order"]);
    expect(typeName(setMemo.parameters[0]!.type)).toBe("SalesOrder");
  });

  it("reports signature problems: duplicates, reserved names, bad types, duplicate parameters", () => {
    expect(errors(`fn f() { }\nfn f() { }\nscheduled { }\n`)).toEqual(["SAIL1039 'f' is already the name of another function (line 1); choose another name for this function"]);
    expect(errors(`fn load(x: Number) { }\nscheduled { }\n`)).toEqual(["SAIL1039 'load' is already the name of a built-in; choose another name for this function"]);
    expect(errors(`fn Customer() { }\nscheduled { }\n`)).toEqual(["SAIL1039 'Customer' is already the name of a record type; choose another name for this function"]);
    expect(errors(`fn f(a: Number, a: Number) { }\nscheduled { }\n`)).toEqual(["SAIL1017 'a' is already a parameter of 'f'"]);
    expect(errors(`fn f(x: Nmber) { }\nscheduled { }\n`)).toEqual([
      "SAIL1040 Unknown parameter type 'Nmber' in 'f'. Did you mean 'Number'? Parameters are Text, Number, Bool, or a record type (Customer, Invoice, SailLog, SalesOrder)",
    ]);
    expect(errors(`fn f() -> Customer { }\nscheduled { }\n`)).toEqual(["SAIL1040 'f' cannot return a Customer: functions return Text, Number, or Bool; records flow in through parameters"]);
    expect(errors(`fn f() -> Nope { }\nscheduled { }\n`)).toEqual(["SAIL1040 Unknown return type 'Nope'. Functions return Text, Number, or Bool"]);
    expect(errors(`fn f() { }\n`)).toEqual(["SAIL1015 This file declares functions but no entry point; a Sail file is one script, so add beforeSubmit, afterSubmit, or scheduled"]);
  });

  it("checks returns: missing, wrong type, value from void, and entry points", () => {
    expect(errors(`fn f(x: Number) -> Number {\n    if x > 1 {\n        return x\n    }\n}\nscheduled { }\n`)).toEqual(["SAIL1042 'f' returns Number but not every path ends in 'return'"]);
    expect(errors(`fn f(x: Number) -> Number {\n    if x > 1 {\n        return x\n    } else {\n        return 0\n    }\n}\nscheduled { }\n`)).toEqual([]);
    expect(errors(`fn f(x: Number) -> Number {\n    for row in query Customer {\n        return x\n    }\n}\nscheduled { }\n`)).toEqual(["SAIL1042 'f' returns Number but not every path ends in 'return'"]);
    expect(errors(`fn f() -> Number {\n    return "t"\n}\nscheduled { }\n`)).toEqual(["SAIL1041 Cannot return Text from 'f', which returns Number", "SAIL1042 'f' returns Number but not every path ends in 'return'"]);
    expect(errors(`fn f() -> Number {\n    return\n}\nscheduled { }\n`)[0]).toBe("SAIL1041 'f' must return a Number value");
    expect(errors(`fn f() {\n    return 1\n}\nscheduled { }\n`)).toEqual(["SAIL1041 'f' returns no value; remove the value or declare '-> Number'"]);
    expect(errors(`scheduled {\n    return 1\n}\n`)).toEqual(["SAIL1041 execute returns no value"]);
    expect(errors(`scheduled {\n    let c = load Customer("1")\n    if c.email == "" {\n        return\n    }\n    log.debug(c.email)\n}\n`)).toEqual([]);
  });

  it("checks calls: unknown, count, types, void as value, type arguments, members, and did-you-mean", () => {
    const PRE = `fn count(x: Number) -> Number {\n    return x\n}\nfn note(c: Customer) { }\n`;
    expect(errors(`${PRE}scheduled {\n    cont(1)\n}\n`)[0]).toContain("SAIL1010 Unknown identifier 'cont'. Did you mean 'count'?");
    expect(errors(`${PRE}scheduled {\n    count(1, 2)\n}\n`)).toEqual(["SAIL1013 'count' expects 1 argument (x: Number), but received 2"]);
    expect(errors(`${PRE}scheduled {\n    count("a")\n}\n`)).toEqual(["SAIL1014 'count' parameter 'x' must be Number, but received Text"]);
    expect(errors(`${PRE}scheduled {\n    let c = load Customer("1")\n    let v = note(c)\n}\n`)).toEqual(["SAIL1006 Cannot initialize 'v' with this expression, which returns Void"]);
    expect(errors(`${PRE}scheduled {\n    if count(1) { }\n}\n`)[0]).toContain("SAIL1021 if condition must be Bool, but received Number");
    expect(errors(`${PRE}scheduled {\n    count Customer(1)\n}\n`)).toEqual(["SAIL1018 'count' does not take a record type; write count(...)"]);
    expect(errors(`${PRE}scheduled {\n    count.x\n}\n`)).toEqual(["SAIL1011 'count' is a function and has no member 'x'"]);
    expect(errors(`${PRE}scheduled {\n    log.debug(count)\n}\n`)).toEqual(["SAIL1006 'count' is a function and must be called, like 'count(...)'"]);
    expect(errors(`${PRE}scheduled {\n    let count = 1\n    log.debug(count(1))\n}\n`)[0]).toContain("'count' is a Number value and cannot be called");
  });

  it("record arguments must be named records that are not query rows", () => {
    const PRE = `fn note(c: Customer) {\n    c.comments = "x"\n}\n`;
    expect(errors(`${PRE}scheduled {\n    for row in query Customer {\n        note(row)\n    }\n}\n`)).toEqual([
      "SAIL1044 A query row cannot be passed to 'note' as a Customer: a row is a read-only view, not a record. Load it first: 'let x = load Customer(row.id)'",
    ]);
    expect(errors(`${PRE}scheduled {\n    note(load Customer("1"))\n}\n`)).toEqual(["SAIL1044 Pass a named record to 'note': declare it first, like 'let x = load Customer(...)', then 'note(x)'"]);
    expect(errors(`${PRE}scheduled {\n    let o = load SalesOrder("1")\n    note(o)\n}\n`)).toEqual(["SAIL1014 'note' parameter 'c' must be Customer, but received SalesOrder"]);
  });
});

describe("lifecycle analysis across calls", () => {
  function diagnostics(source: string) {
    return compileSail(source).diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`);
  }
  const SET = `fn setMemo(order: SalesOrder) {\n    order.memo = "Updated"\n}\n`;
  const PERSIST = `fn persist(order: SalesOrder) {\n    order.memo = "x"\n    save order\n}\n`;
  const DROP = `fn drop(order: SalesOrder) {\n    delete order\n}\n`;
  const MAYBE = `fn maybeSave(order: SalesOrder, flag: Bool) {\n    order.memo = "y"\n    if flag {\n        save order\n    }\n}\n`;

  it("a function that modifies its parameter leaves the caller's record pending until the caller saves", () => {
    expect(diagnostics(`${SET}scheduled {\n    let order = load SalesOrder("1")\n    setMemo(order)\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified by 'setMemo' but never saved; changes to a loaded SalesOrder are discarded unless you 'save order'",
    ]);
    expect(diagnostics(`${SET}scheduled {\n    let order = load SalesOrder("1")\n    setMemo(order)\n    save order\n}\n`)).toEqual([]);
    expect(diagnostics(`${SET}scheduled {\n    let order = load SalesOrder("1")\n    save order\n    setMemo(order)\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified by 'setMemo' after its last save; this change to the loaded SalesOrder is discarded unless you 'save order' again",
    ]);
    // Inside the function, the parameter's pending change is not reported: it is the caller's.
    expect(diagnostics(`${SET}scheduled { }\n`)).toEqual([]);
  });

  it("a function that saves clears the caller's pending state, and one that may save only sometimes does not", () => {
    expect(diagnostics(`${PERSIST}scheduled {\n    let order = load SalesOrder("1")\n    order.memo = "before"\n    persist(order)\n}\n`)).toEqual([]);
    expect(diagnostics(`${PERSIST}scheduled {\n    let order = create SalesOrder\n    persist(order)\n}\n`)).toEqual([]);
    expect(diagnostics(`${MAYBE}scheduled {\n    let order = load SalesOrder("1")\n    maybeSave(order, true)\n}\n`)).toEqual([
      "warning SAIL2001 'order' may leave this script with unsaved changes: it is modified by 'maybeSave' here, but not every execution path that follows performs 'save order'",
    ]);
    expect(diagnostics(`${MAYBE}scheduled {\n    let order = create SalesOrder\n    maybeSave(order, true)\n}\n`)).toEqual([
      "warning SAIL2001 'order' may leave this script unsaved: it is created here, but not every execution path that follows performs 'save order'",
    ]);
  });

  it("a function that deletes consumes the caller's record and needs it persisted first", () => {
    expect(diagnostics(`${DROP}scheduled {\n    let order = load SalesOrder("1")\n    drop(order)\n    log.debug(order.memo)\n    drop(order)\n}\n`)).toEqual([
      "error SAIL1027 Cannot read field 'memo' because 'order' has been deleted",
      "error SAIL1027 'order' has been deleted and cannot be used",
    ]);
    expect(diagnostics(`${DROP}scheduled {\n    let order = create SalesOrder\n    drop(order)\n}\n`)).toEqual([
      "error SAIL1026 Cannot pass 'order' to 'drop', which deletes it, before it has been saved: a new SalesOrder does not exist in NetSuite until you 'save order'",
      "warning SAIL2001 'order' is created but never saved; a new SalesOrder does not exist in NetSuite until you 'save order'",
    ]);
    expect(diagnostics(`${DROP}scheduled {\n    let order = load SalesOrder("1")\n    if order.memo == "" {\n        drop(order)\n    }\n    order.memo = "x"\n}\n`)).toEqual([
      "error SAIL1027 Cannot assign SalesOrder.memo because 'order' may already have been deleted on this path",
    ]);
  });

  it("context records follow the hook rules through calls", () => {
    expect(diagnostics(`${SET}beforeSubmit edit (order: SalesOrder) {\n    setMemo(order)\n}\n`)).toEqual([]);
    expect(diagnostics(`${SET}afterSubmit edit (order: SalesOrder) {\n    setMemo(order)\n}\n`)).toEqual([
      "error SAIL1044 'order' cannot be passed to 'setMemo' in afterSubmit: the function modifies it, and the SalesOrder is already saved, so the change would be silently discarded",
    ]);
    expect(diagnostics(`fn peek(order: SalesOrder) -> Text {\n    return order.memo\n}\nafterSubmit edit (order: SalesOrder) {\n    log.debug(peek(order))\n}\n`)).toEqual([]);
    expect(diagnostics(`${PERSIST}beforeSubmit edit (order: SalesOrder) {\n    persist(order)\n}\n`)).toEqual([
      "error SAIL1044 'order' is the SalesOrder from beforeSubmit and cannot be passed to 'persist', which saves it: NetSuite owns its persistence",
    ]);
    expect(diagnostics(`${DROP}beforeSubmit edit (order: SalesOrder) {\n    drop(order)\n}\n`)[0]).toContain("cannot be passed to 'drop', which deletes it");
  });

  it("summaries compose through nested calls, functions keep their own local rules, and recursion is refused", () => {
    expect(diagnostics(`${SET}fn twice(order: SalesOrder) {\n    setMemo(order)\n    setMemo(order)\n}\nscheduled {\n    let order = load SalesOrder("1")\n    twice(order)\n}\n`)).toEqual([
      "warning SAIL2001 'order' is modified by 'twice' but never saved; changes to a loaded SalesOrder are discarded unless you 'save order'",
    ]);
    expect(diagnostics(`fn leak() {\n    let c = create Customer\n    c.email = "x"\n}\nscheduled {\n    leak()\n}\n`)).toEqual([
      "warning SAIL2001 'c' is created but never saved; a new Customer does not exist in NetSuite until you 'save c'",
    ]);
    expect(diagnostics(`fn rec(x: Number) {\n    rec(x)\n}\nscheduled {\n    rec(1)\n}\n`)).toEqual(["error SAIL1043 Recursive calls are not supported: 'rec' is called while its own body is being analyzed"]);
    expect(diagnostics(`fn a() {\n    b()\n}\nfn b() {\n    a()\n}\nscheduled {\n    a()\n}\n`)).toEqual(["error SAIL1043 Recursive calls are not supported: 'a' is called while its own body is being analyzed"]);
  });

  it("returns end a path: state after an early return is not merged into the fall-through", () => {
    expect(diagnostics(`fn finish(order: SalesOrder, flag: Bool) {\n    if flag {\n        save order\n        return\n    }\n    order.memo = "x"\n    save order\n}\nscheduled {\n    let order = load SalesOrder("1")\n    order.memo = "a"\n    finish(order, true)\n}\n`)).toEqual([]);
    expect(diagnostics(`scheduled {\n    let c = load Customer("1")\n    c.comments = "x"\n    if c.email == "" {\n        save c\n        return\n    }\n    log.debug(c.email)\n}\n`)).toEqual([
      "warning SAIL2001 'c' may leave this script with unsaved changes: it is modified here, but not every execution path that follows performs 'save c'",
    ]);
  });
});
