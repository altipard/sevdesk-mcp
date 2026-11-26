/**
 * Anonymised sevdesk answers, shaped after the response schemas of the spec
 * (Model_*Response): IDs, amounts and status codes as strings, dates with
 * German offset, nested references as { id, objectName }. Names, numbers
 * and addresses are invented. Some fields are null or empty on purpose,
 * because live data has them.
 */

const ref = (id: number | string, objectName: string) => ({ id: String(id), objectName });
const sevClient = ref(900001, "SevClient");

export function list<T>(objects: T[], total?: number) {
  return total === undefined ? { objects } : { total: String(total), objects };
}

export function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "1001",
    objectName: "Invoice",
    invoiceNumber: "RE-1001",
    contact: ref(2001, "Contact"),
    create: "2026-01-15T09:12:44+01:00",
    update: "2026-01-16T10:00:00+01:00",
    sevClient,
    invoiceDate: "2026-01-15T00:00:00+01:00",
    header: "Rechnung Nr. RE-1001",
    headText: null,
    footText: null,
    timeToPay: "14",
    discountTime: "0",
    discount: "0",
    addressCountry: ref(1, "StaticCountry"),
    payDate: null,
    createUser: ref(3001, "SevUser"),
    deliveryDate: "2026-01-15T00:00:00+01:00",
    status: "200",
    smallSettlement: false,
    contactPerson: ref(3001, "SevUser"),
    taxRate: "0",
    taxRule: ref(1, "TaxRule"),
    taxText: "Umsatzsteuer 19%",
    dunningLevel: null,
    taxType: "default",
    sendDate: "2026-01-15T00:00:00+01:00",
    invoiceType: "RE",
    address: "Muster GmbH\nBeispielweg 1\n12345 Musterstadt",
    currency: "EUR",
    sumNet: "100",
    sumTax: "19",
    sumGross: "119",
    sumDiscounts: "0",
    paidAmount: 0,
    customerInternalNote: null,
    showNet: true,
    enshrined: null,
    sendType: "VPDF",
    ...overrides,
  };
}

export function invoicePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "5001",
    objectName: "InvoicePos",
    create: "2026-01-15T09:12:44+01:00",
    update: "2026-01-15T09:12:44+01:00",
    invoice: ref(1001, "Invoice"),
    part: null,
    quantity: "2",
    price: "50",
    name: "Beratung",
    unity: ref(9, "Unity"),
    sevClient,
    positionNumber: "1",
    text: "Workshop, halber Tag",
    discount: null,
    taxRate: "19",
    sumDiscount: "0",
    sumNetAccounting: "100",
    sumTaxAccounting: "19",
    sumGrossAccounting: "119",
    priceNet: "50",
    priceGross: "59.5",
    priceTax: "9.5",
    ...overrides,
  };
}

export function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: "2001",
    objectName: "Contact",
    create: "2025-03-01T08:00:00+01:00",
    update: "2025-03-01T08:00:00+01:00",
    name: "Muster GmbH",
    status: "1000",
    customerNumber: "10001",
    parent: null,
    surename: null,
    familyname: null,
    titel: null,
    category: ref(3, "Category"),
    description: "",
    academicTitle: null,
    gender: null,
    sevClient,
    name2: null,
    birthday: null,
    vatNumber: "DE000000000",
    bankAccount: null,
    bankNumber: null,
    defaultCashbackTime: null,
    defaultCashbackPercent: null,
    defaultTimeToPay: "14",
    taxNumber: null,
    taxOffice: null,
    exemptVat: "0",
    defaultDiscountAmount: null,
    defaultDiscountPercentage: null,
    buyerReference: null,
    governmentAgency: "0",
    additionalInformation: null,
    ...overrides,
  };
}

export function person(overrides: Record<string, unknown> = {}) {
  return contact({
    id: "2002",
    name: null,
    surename: "Erika",
    familyname: "Beispiel",
    customerNumber: "10002",
    parent: ref(2001, "Contact"),
    vatNumber: null,
    ...overrides,
  });
}

export function address(overrides: Record<string, unknown> = {}) {
  return {
    id: 4001,
    objectName: "ContactAddress",
    create: "2025-03-01T08:00:00+01:00",
    update: "2025-03-01T08:00:00+01:00",
    contact: ref(2001, "Contact"),
    street: "Beispielweg 1",
    zip: "12345",
    city: "Musterstadt",
    country: ref(1, "StaticCountry"),
    category: ref(47, "Category"),
    name: null,
    sevClient,
    ...overrides,
  };
}

export function communicationWay(overrides: Record<string, unknown> = {}) {
  return {
    id: "6001",
    objectName: "CommunicationWay",
    create: "2025-03-01T08:00:00+01:00",
    update: "2025-03-01T08:00:00+01:00",
    contact: ref(2001, "Contact"),
    type: "EMAIL",
    value: "buchhaltung@muster.example",
    key: ref(8, "CommunicationWayKey"),
    main: "1",
    sevClient,
    ...overrides,
  };
}

export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "7001",
    objectName: "Order",
    create: "2026-02-01T09:00:00+01:00",
    update: "2026-02-01T09:00:00+01:00",
    orderNumber: "AN-1001",
    contact: ref(2001, "Contact"),
    orderDate: "2026-02-01T00:00:00+01:00",
    status: "200",
    header: "Angebot AN-1001",
    headText: null,
    footText: null,
    addressCountry: ref(1, "StaticCountry"),
    createUser: ref(3001, "SevUser"),
    sevClient,
    deliveryTerms: null,
    paymentTerms: null,
    origin: null,
    version: "0",
    smallSettlement: false,
    contactPerson: ref(3001, "SevUser"),
    taxRate: "0",
    taxRule: ref(1, "TaxRule"),
    taxSet: null,
    taxText: "Umsatzsteuer 19%",
    taxType: "default",
    orderType: "AN",
    sendDate: null,
    address: "Muster GmbH\nBeispielweg 1\n12345 Musterstadt",
    currency: "EUR",
    sumNet: "1000",
    sumTax: "190",
    sumGross: "1190",
    sumDiscounts: "0",
    customerInternalNote: null,
    showNet: true,
    sendType: null,
    ...overrides,
  };
}

export function voucher(overrides: Record<string, unknown> = {}) {
  return {
    id: "8001",
    objectName: "Voucher",
    mapAll: true,
    create: "2026-03-02T11:00:00+01:00",
    update: "2026-03-02T11:00:00+01:00",
    sevClient,
    createUser: ref(3001, "SevUser"),
    voucherDate: "2026-03-01T00:00:00+01:00",
    supplier: ref(2003, "Contact"),
    supplierName: "Bürobedarf Beispiel KG",
    description: "Druckerpapier",
    document: null,
    payDate: null,
    status: "100",
    sumNet: "42.02",
    sumTax: "7.98",
    sumGross: "50",
    sumNetAccounting: "42.02",
    sumTaxAccounting: "7.98",
    sumGrossAccounting: "50",
    sumDiscounts: "0",
    sumDiscountsForeignCurrency: "0",
    paidAmount: 0,
    taxRule: ref(9, "TaxRule"),
    taxType: "default",
    creditDebit: "D",
    costCentre: null,
    voucherType: "VOU",
    currency: "EUR",
    propertyForeignCurrencyDeadline: null,
    propertyExchangeRate: null,
    recurringInterval: null,
    recurringStartDate: null,
    recurringNextVoucher: null,
    recurringLastVoucher: null,
    recurringEndDate: null,
    enshrined: null,
    taxSet: null,
    paymentDeadline: "2026-03-15T00:00:00+01:00",
    deliveryDate: "2026-03-01T00:00:00+01:00",
    deliveryDateUntil: null,
    ...overrides,
  };
}

export function voucherPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "8501",
    objectName: "VoucherPos",
    create: "2026-03-02T11:00:00+01:00",
    update: "2026-03-02T11:00:00+01:00",
    sevClient,
    voucher: ref(8001, "Voucher"),
    accountDatev: ref(6815, "AccountDatev"),
    accountingType: null,
    estimatedAccountingType: null,
    taxRate: "19",
    net: false,
    isAsset: false,
    sumNet: "42.02",
    sumTax: "7.98",
    sumGross: "50",
    sumNetAccounting: "42.02",
    sumTaxAccounting: "7.98",
    sumGrossAccounting: "50",
    comment: null,
    ...overrides,
  };
}

export function checkAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "9001",
    objectName: "CheckAccount",
    create: "2025-01-01T00:00:00+01:00",
    update: "2026-03-01T06:00:00+01:00",
    sevClient,
    name: "Geschäftskonto",
    iban: "DE00 0000 0000 0000 0000 00",
    type: "online",
    importType: null,
    currency: "EUR",
    defaultAccount: "1",
    baseAccount: "0",
    priority: "1",
    status: "100",
    balance: "12345.67",
    bankServer: null,
    autoMapTransactions: "1",
    autoSyncTransactions: "1",
    lastSync: "2026-03-01T06:00:00+01:00",
    accountingNumber: "1800",
    bic: "XXXXDEXXXXX",
    ...overrides,
  };
}

export function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "9501",
    objectName: "CheckAccountTransaction",
    create: "2026-03-01T06:00:00+01:00",
    update: "2026-03-01T06:00:00+01:00",
    sevClient,
    valueDate: "2026-02-28T00:00:00+01:00",
    entryDate: "2026-02-28T00:00:00+01:00",
    paymtPurpose: "RE-1001 Muster GmbH",
    amount: "119",
    payeePayerName: "Muster GmbH",
    payeePayerAcctNo: "DE00000000000000000000",
    payeePayerBankCode: null,
    gvCode: null,
    entryText: null,
    primaNotaNo: null,
    checkAccount: ref(9001, "CheckAccount"),
    status: "100",
    sourceTransaction: null,
    targetTransaction: null,
    enshrined: null,
    ...overrides,
  };
}

export function part(overrides: Record<string, unknown> = {}) {
  return {
    id: 9801,
    objectName: "Part",
    create: "2025-05-01T00:00:00+02:00",
    update: "2025-05-01T00:00:00+02:00",
    name: "Beratungsstunde",
    partNumber: "ART-001",
    text: "Eine Stunde Beratung",
    category: ref(1, "Category"),
    stock: 0,
    stockEnabled: false,
    unity: ref(9, "Unity"),
    price: 100,
    priceNet: 100,
    priceGross: 119,
    sevClient,
    pricePurchase: null,
    taxRate: 19,
    status: 100,
    internalComment: null,
    ...overrides,
  };
}

export function receiptGuide(overrides: Record<string, unknown> = {}) {
  return {
    accountDatevId: 4400,
    accountNumber: "4400",
    accountName: "Erlöse 19 % USt",
    description: "Einnahmen aus dem Verkauf von Waren und Dienstleistungen",
    allowedTaxRules: [
      {
        name: "USTPFL_UMS_EINN",
        description: "Umsatzsteuerpflichtige Umsätze",
        id: 1,
        taxRates: ["NINETEEN"],
      },
    ],
    allowedReceiptTypes: ["REVENUE"],
    ...overrides,
  };
}

/** "%PDF-1.4" followed by bytes; small enough for tests, recognisable as PDF. */
export const PDF_BYTES = Buffer.from("%PDF-1.4\n% sevdesk-mcp test document\n%%EOF\n", "latin1");

export function pdfDocument(overrides: Record<string, unknown> = {}) {
  return {
    filename: "RE-1001.pdf",
    mimeType: "application/pdf",
    base64encoded: true,
    content: PDF_BYTES.toString("base64"),
    ...overrides,
  };
}
