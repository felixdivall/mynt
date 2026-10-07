import { compile, type CompileResult } from "../src/compiler.js";
import { DocumentSchemaProvider } from "../src/schema/provider.js";
import type { SchemaDocument } from "../src/schema/types.js";

/** The test fixture schema. Same shape as schemas/builtin.json on purpose. */
export const fixtureSchema: SchemaDocument = {
  myntSchemaVersion: 1,
  source: { kind: "builtin" },
  records: {
    customer: {
      name: "Customer",
      suiteScriptType: "CUSTOMER",
      fields: {
        comments: { type: "Text", label: "Comments", writable: true },
        email: { type: "Text", label: "Email", writable: true },
        entityid: { type: "Text", label: "ID", writable: false },
      },
    },
    salesorder: {
      name: "SalesOrder",
      suiteScriptType: "SALES_ORDER",
      fields: {
        memo: { type: "Text", label: "Memo", writable: true },
        total: { type: "Number", label: "Total", writable: false },
      },
      sublists: {
        item: {
          label: "Items",
          fields: {
            item: { type: "Text", label: "Item", writable: true },
            quantity: { type: "Number", label: "Quantity", writable: true },
            rate: { type: "Number", label: "Rate", writable: true },
            amount: { type: "Number", label: "Amount", writable: false },
            description: { type: "Text", label: "Description", writable: true },
          },
        },
      },
    },
    customrecord_mynt_log: {
      name: "MyntLog",
      custom: true,
      fields: {
        name: { type: "Text", label: "Name", writable: true },
        custrecord_mynt_message: { type: "Text", label: "Message", writable: true, custom: true },
        custrecord_mynt_done: { type: "Bool", label: "Done", writable: true, custom: true },
      },
    },
    invoice: {
      name: "Invoice",
      suiteScriptType: "INVOICE",
      fields: {
        memo: { type: "Text", label: "Memo", writable: true },
        tranid: { type: "Text", label: "Invoice #", writable: true },
        total: { type: "Number", label: "Total", writable: false },
      },
      sublists: {
        item: {
          label: "Items",
          fields: {
            item: { type: "Text", label: "Item", writable: true },
            quantity: { type: "Number", label: "Quantity", writable: true },
            rate: { type: "Number", label: "Rate", writable: true },
            amount: { type: "Number", label: "Amount", writable: false },
            description: { type: "Text", label: "Description", writable: true },
          },
        },
      },
    },
  },
};

export const schema = new DocumentSchemaProvider(fixtureSchema);

export function compileMynt(source: string, file = "test.mn"): CompileResult {
  return compile(source, { file, schema });
}

export function errorCodes(result: CompileResult): string[] {
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}
