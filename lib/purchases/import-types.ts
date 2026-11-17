export type PurchaseImportSourceItem = {
  sourceRow: number;
  code: string;
  description: string;
  spreadsheetLine: string | null;
  quantity: number;
  discountPercent: number;
  unitPrice: number | null;
  importAmount: number;
};

export type PurchaseImportSummary = {
  subtotal: number | null;
  discount: number | null;
  financialDiscount: number | null;
  ieps: number | null;
  iva: number | null;
  total: number | null;
};

export type PurchaseImportDraft = {
  jobId: string;
  sourceSheet: string;
  sourceRows: number[];
  supplierName: string;
  purchaseDate: string;
  ticketNumber: string;
  items: PurchaseImportSourceItem[];
  summary: PurchaseImportSummary;
  warnings: string[];
};

export type PurchaseImportEquivalence = {
  materiaprima: number;
  nombre: string;
  equivalencia: number;
};

export type PurchaseImportDepartment = {
  id: number;
  nombre: string;
};

export type PurchaseImportPreviewResponse = {
  batchId: string;
  fileName: string;
  purchases: PurchaseImportDraft[];
  equivalences: PurchaseImportEquivalence[];
  departments: PurchaseImportDepartment[];
};

export type PurchaseImportEditedItem = {
  productId: number;
  quantity: number;
  subtotal: number;
  discount: number;
  taxes: number;
};

export type PurchaseImportSubmission = {
  jobId: string;
  ticketNumber: string;
  purchaseDate: string;
  supplierId: number;
  items: PurchaseImportEditedItem[];
};

export type PurchaseImportSubmitResult = {
  jobId: string;
  ok: boolean;
  status?: string;
  error?: string;
};
