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
      searchFamily: "transaction",
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
      searchFamily: "transaction",
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

/**
 * The fixture plus explicit reference metadata, for the reference tests.
 * Separate from `fixtureSchema` so the many tests that list a record's
 * fields are untouched. The metadata is stated here, as a pulled snapshot
 * would state it; nothing is inferred from names. `parent` has no target
 * on purpose, and `category` is the one multiselect, which live extraction
 * cannot produce yet.
 */
export const referenceFixtureSchema: SchemaDocument = {
  ...fixtureSchema,
  /**
   * Saved searches the "account" knows, as a pulled snapshot would state
   * them. Account metadata for tests only; the builtin sample has none.
   * `customsearch_system_notes` is a standalone search type, which
   * `search.load` must be told the type of.
   */
  savedSearches: {
    customsearch_customers: { record: "Customer" },
    customsearch_active_customers: { record: "Customer" },
    customsearch_open_orders: { record: "SalesOrder" },
    customsearch_system_notes: { record: "SystemNote", searchType: "systemnote" },
    customsearch_totals: { record: "SalesOrder" },
  },
  records: {
    ...fixtureSchema.records,
    customer: {
      ...fixtureSchema.records.customer!,
      fields: {
        ...fixtureSchema.records.customer!.fields,
        subsidiary: { type: "Ref", label: "Subsidiary", writable: true, refTarget: "Subsidiary", selection: "single" },
        parent: { type: "Ref", label: "Parent Company", writable: true, selection: "single" },
        category: { type: "Ref", label: "Category", writable: true, refTarget: "CustomerCategory", selection: "multiple" },
      },
    },
    salesorder: {
      ...fixtureSchema.records.salesorder!,
      fields: {
        ...fixtureSchema.records.salesorder!.fields,
        entity: { type: "Ref", label: "Customer", writable: true, refTarget: "Customer", selection: "single" },
        amount: { type: "Number", label: "Amount", writable: false },
        mainline: { type: "Bool", label: "Main Line", writable: false },
        trandate: { type: "Date", label: "Date", writable: true },
        subsidiary: { type: "Ref", label: "Subsidiary", writable: true, refTarget: "Subsidiary", selection: "single" },
      },
    },
    subsidiary: {
      name: "Subsidiary",
      suiteScriptType: "SUBSIDIARY",
      fields: {
        name: { type: "Text", label: "Name", writable: true },
        country: { type: "Text", label: "Country", writable: true },
      },
    },
    customercategory: {
      name: "CustomerCategory",
      suiteScriptType: "CUSTOMER_CATEGORY",
      fields: {
        name: { type: "Text", label: "Name", writable: true },
      },
    },
    /**
     * A field-mapping custom record, shaped like the integration use case
     * where one search reads every mapping row: text fields with values,
     * booleans, a select with a known target, and one whose target the
     * metadata does not name.
     */
    customrecord_field_mapping: {
      name: "FieldMapping",
      custom: true,
      fields: {
        type: { type: "Text", label: "Type", writable: true, values: ["body", "line", "sublist"] },
        externalfieldid: { type: "Text", label: "External Field Id", writable: true },
        netsuitefieldid: { type: "Text", label: "NetSuite Field Id", writable: true },
        netsuitefieldtype: { type: "Text", label: "NetSuite Field Type", writable: true, values: ["text", "select", "checkbox", "date"] },
        netsuitefieldrectype: { type: "Ref", label: "NetSuite Field Record Type", writable: true, selection: "single" },
        netsuiteconnectorfield: { type: "Ref", label: "Connector Field", writable: true, refTarget: "Customer", selection: "single" },
        defaultvalue: { type: "Text", label: "Default Value", writable: true },
        suiteql: { type: "Text", label: "SuiteQL", writable: true },
        inclusion: { type: "Bool", label: "Include", writable: true },
        searchfield: { type: "Text", label: "Search Field", writable: true },
        searchjoin: { type: "Text", label: "Search Join", writable: true },
        searchgetmethod: { type: "Text", label: "Search Get Method", writable: true, values: ["getValue", "getText"] },
        sortorder: { type: "Number", label: "Sort Order", writable: true },
      },
    },
    systemnote: {
      name: "SystemNote",
      fields: {
        field: { type: "Text", label: "Field", writable: false },
        newvalue: { type: "Text", label: "New Value", writable: false },
      },
    },
  },
};

export const referenceSchema = new DocumentSchemaProvider(referenceFixtureSchema);

export function compileMynt(source: string, file = "test.mn"): CompileResult {
  return compile(source, { file, schema });
}

export function errorCodes(result: CompileResult): string[] {
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}
