/**
 * `record.Type` constant names for standard records, keyed by SuiteScript
 * record id. This is a hand-maintained platform table: NetSuite's metadata
 * does not expose the constant names, and deriving them from record names
 * would be a guess (`salesorder` -> `SALES_ORDER` has no mechanical rule).
 *
 * A record missing here is not an error. The emitter then addresses it by
 * its id string, which is exactly the constant's value, so generated code
 * stays correct; it just reads `"salesorder"` instead of
 * `record.Type.SALES_ORDER`.
 */
export const RECORD_TYPE_CONSTANTS: Readonly<Record<string, string>> = {
  account: "ACCOUNT",
  cashsale: "CASH_SALE",
  classification: "CLASSIFICATION",
  contact: "CONTACT",
  creditmemo: "CREDIT_MEMO",
  currency: "CURRENCY",
  customer: "CUSTOMER",
  customerpayment: "CUSTOMER_PAYMENT",
  department: "DEPARTMENT",
  employee: "EMPLOYEE",
  estimate: "ESTIMATE",
  inventoryitem: "INVENTORY_ITEM",
  invoice: "INVOICE",
  itemfulfillment: "ITEM_FULFILLMENT",
  journalentry: "JOURNAL_ENTRY",
  location: "LOCATION",
  noninventoryitem: "NON_INVENTORY_ITEM",
  opportunity: "OPPORTUNITY",
  partner: "PARTNER",
  phonecall: "PHONE_CALL",
  purchaseorder: "PURCHASE_ORDER",
  returnauthorization: "RETURN_AUTHORIZATION",
  salesorder: "SALES_ORDER",
  serviceitem: "SERVICE_ITEM",
  subsidiary: "SUBSIDIARY",
  supportcase: "SUPPORT_CASE",
  task: "TASK",
  vendor: "VENDOR",
  vendorbill: "VENDOR_BILL",
  vendorpayment: "VENDOR_PAYMENT",
};
