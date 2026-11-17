"use client";

import { FileSpreadsheet, LoaderCircle, RotateCw, ScanEye } from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { AutocompleteSelect } from "@/components/autocomplete-select";
import { notify } from "@/lib/notifications";
import type { PurchaseProduct, PurchaseSupplier } from "@/lib/purchase-catalogs";
import type {
  PurchaseImportDepartment,
  PurchaseImportDraft,
  PurchaseImportEquivalence,
  PurchaseImportPreviewResponse,
  PurchaseImportSubmitResult,
} from "@/lib/purchases/import-types";

type ImportLine = {
  key: string;
  sourceRow: number;
  sourceCode: string;
  sourceDescription: string;
  spreadsheetLine: string | null;
  sourceQuantity: number;
  discountPercent: number;
  sourceImportAmount: number;
  productId: number | null;
  productName: string;
  departmentName: string;
  unit: string;
  equivalenceFactor: number;
  equivalenceName: string | null;
  equivalenceAmbiguous: boolean;
  quantity: number;
  subtotal: number;
  discount: number;
  taxes: number;
  warnings: string[];
};

type ExpectedSummary = {
  subtotal: number | null;
  discount: number | null;
  taxes: number | null;
  total: number | null;
};

type ImportPurchase = {
  draft: PurchaseImportDraft;
  supplierId: number | null;
  lines: ImportLine[];
  summary: ExpectedSummary;
  warnings: string[];
  generalDiscountRate: number | null;
  confirmed: boolean;
  submitResult: PurchaseImportSubmitResult | null;
};

type Props = {
  branch: string;
  enabled: boolean;
  catalogReady: boolean;
  catalogMessage: string;
  products: PurchaseProduct[];
  suppliers: PurchaseSupplier[];
};

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CURRENCY = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleUpperCase("es-MX")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function money(value: number) {
  return CURRENCY.format(value);
}

function newJobId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function matchingEquivalence(
  description: string,
  productId: number,
  equivalences: PurchaseImportEquivalence[],
) {
  const normalizedDescription = ` ${normalize(description)} `;
  const matches = equivalences
    .filter((row) => row.materiaprima === productId)
    .map((row) => ({ row, name: normalize(row.nombre) }))
    .filter(({ name }) => name && normalizedDescription.includes(` ${name} `))
    .sort((left, right) => right.name.length - left.name.length);
  if (matches.length === 0) return { factor: 1, name: null, ambiguous: false, matched: false };

  const longestLength = matches[0].name.length;
  const longest = matches.filter((match) => match.name.length === longestLength);
  const factors = new Set(longest.map((match) => Number(match.row.equivalencia)));
  if (factors.size > 1) {
    return { factor: 1, name: null, ambiguous: true, matched: true };
  }
  return {
    factor: Number(longest[0].row.equivalencia),
    name: longest[0].row.nombre,
    ambiguous: false,
    matched: true,
  };
}

function createPurchasePreview(
  draft: PurchaseImportDraft,
  products: PurchaseProduct[],
  suppliers: PurchaseSupplier[],
  equivalences: PurchaseImportEquivalence[],
  departments: PurchaseImportDepartment[],
): ImportPurchase {
  const supplierName = normalize(draft.supplierName);
  const matchedSuppliers = suppliers.filter((supplier) => normalize(supplier.nombre ?? "") === supplierName);
  const supplierId = matchedSuppliers.length === 1 ? matchedSuppliers[0].id : null;
  const departmentById = new Map(departments.map((department) => [department.id, department.nombre]));
  const lines: ImportLine[] = draft.items.map((source, index) => {
    const matchedProducts = products.filter((product) =>
      (product.codigo ?? "").trim().toLocaleUpperCase("es-MX") === source.code.trim().toLocaleUpperCase("es-MX"),
    );
    const product = matchedProducts.length === 1 ? matchedProducts[0] : null;
    const equiv = product
      ? matchingEquivalence(source.description, product.id, equivalences)
      : { factor: 1, name: null, ambiguous: false, matched: false };
    const baseSubtotal = source.unitPrice !== null
      ? roundMoney(source.quantity * source.unitPrice)
      : roundMoney(source.importAmount);
    const warnings: string[] = [];

    if (matchedProducts.length === 0) warnings.push(`La clave ${source.code} no coincide con un producto activo.`);
    if (matchedProducts.length > 1) warnings.push(`La clave ${source.code} coincide con varios productos activos.`);
    if (product && !equiv.matched) warnings.push("No se encontró equivalencia; se usará factor 1.");
    if (equiv.ambiguous) warnings.push("Hay equivalencias con igual longitud y distintos factores; indica el factor correcto.");
    if (source.discountPercent < 0 || source.discountPercent >= 100) warnings.push("El porcentaje de descuento de la línea debe estar entre 0 y 100.");
    if (source.unitPrice !== null) {
      const explicitDiscount = source.discountPercent > 0 && source.discountPercent < 100
        ? roundMoney(baseSubtotal * source.discountPercent / 100)
        : 0;
      const amountMatchesGross = Math.abs(roundMoney(source.importAmount) - baseSubtotal) <= 0.01;
      const amountMatchesNet = Math.abs(roundMoney(source.importAmount) - roundMoney(baseSubtotal - explicitDiscount)) <= 0.01;
      if (!amountMatchesGross && !amountMatchesNet) warnings.push("El importe no coincide con cantidad por P/U; revisa el subtotal de esta línea.");
    }

    return {
      key: `${draft.jobId}-${source.sourceRow}-${index}`,
      sourceRow: source.sourceRow,
      sourceCode: source.code,
      sourceDescription: source.description,
      spreadsheetLine: source.spreadsheetLine,
      sourceQuantity: source.quantity,
      discountPercent: source.discountPercent,
      sourceImportAmount: source.importAmount,
      productId: product?.id ?? null,
      productName: product?.nombre ?? "",
      departmentName: product ? departmentById.get(product.departamento) ?? "" : "",
      unit: product?.unidad ?? "",
      equivalenceFactor: equiv.factor,
      equivalenceName: equiv.name,
      equivalenceAmbiguous: equiv.ambiguous,
      quantity: roundMoney(source.quantity * equiv.factor),
      subtotal: baseSubtotal,
      discount: 0,
      taxes: 0,
      warnings,
    };
  });

  const explicitDiscount = roundMoney(lines.reduce((sum, line) =>
    sum + (line.discountPercent > 0 && line.discountPercent < 100
      ? roundMoney(line.subtotal * line.discountPercent / 100)
      : 0), 0));
  const summaryDiscount = draft.summary.discount === null && draft.summary.financialDiscount === null
    ? null
    : roundMoney((draft.summary.discount ?? 0) + (draft.summary.financialDiscount ?? 0));
  const eligible = lines.filter((line) => !(line.discountPercent > 0));
  const eligibleSubtotal = roundMoney(eligible.reduce((sum, line) => sum + line.subtotal, 0));
  let generalDiscountRate: number | null = null;
  const warnings = [...draft.warnings];

  for (const line of lines) {
    if (line.discountPercent > 0 && line.discountPercent < 100) {
      line.discount = roundMoney(line.subtotal * line.discountPercent / 100);
    }
  }

  if (summaryDiscount !== null) {
    const residualDiscount = roundMoney(summaryDiscount - explicitDiscount);
    if (residualDiscount < -0.01) {
      warnings.push("Los descuentos explícitos por producto superan el descuento del resumen.");
    } else if (residualDiscount > 0.01 && eligibleSubtotal <= 0) {
      warnings.push("El descuento del resumen no puede distribuirse porque todas las líneas tienen descuento explícito.");
    } else if (eligibleSubtotal > 0) {
      generalDiscountRate = Math.max(0, residualDiscount) / eligibleSubtotal;
      const targetCents = Math.round(Math.max(0, residualDiscount) * 100);
      let allocatedCents = 0;
      eligible.forEach((line, index) => {
        const lineCents = index === eligible.length - 1
          ? targetCents - allocatedCents
          : Math.round(line.subtotal * generalDiscountRate! * 100);
        line.discount = roundMoney(lineCents / 100);
        allocatedCents += lineCents;
      });
    }
  }

  if (summaryDiscount !== null && generalDiscountRate !== null) {
    warnings.push(`Descuento general aplicado: ${(generalDiscountRate * 100).toLocaleString("es-MX", { maximumFractionDigits: 6 })}%.`);
  }
  if ((draft.summary.ieps ?? 0) + (draft.summary.iva ?? 0) > 0) {
    warnings.push("El resumen incluye impuestos; distribúyelos entre los productos antes de enviar.");
  }
  if (matchedSuppliers.length === 0) warnings.push("El proveedor no coincide con un proveedor activo; selecciónalo manualmente.");
  if (matchedSuppliers.length > 1) warnings.push("El proveedor coincide con varios registros; selecciona el correcto.");
  if (draft.summary.subtotal === null) warnings.push("El libro no contiene un subtotal de compra legible.");

  const summary: ExpectedSummary = {
    subtotal: draft.summary.subtotal,
    discount: summaryDiscount,
    taxes: draft.summary.ieps === null && draft.summary.iva === null
      ? null
      : roundMoney((draft.summary.ieps ?? 0) + (draft.summary.iva ?? 0)),
    total: draft.summary.total,
  };

  return {
    draft,
    supplierId,
    lines,
    summary,
    warnings: [...new Set(warnings)],
    generalDiscountRate,
    confirmed: false,
    submitResult: null,
  };
}

function previewTotals(purchase: ImportPurchase) {
  const subtotal = roundMoney(purchase.lines.reduce((sum, line) => sum + roundMoney(Number(line.subtotal || 0)), 0));
  const discount = roundMoney(purchase.lines.reduce((sum, line) => sum + roundMoney(Number(line.discount || 0)), 0));
  const taxes = roundMoney(purchase.lines.reduce((sum, line) => sum + roundMoney(Number(line.taxes || 0)), 0));
  const total = roundMoney(purchase.lines.reduce((sum, line) =>
    sum + roundMoney(roundMoney(line.subtotal) - roundMoney(line.discount) + roundMoney(line.taxes)), 0));
  return { subtotal, discount, taxes, total };
}

function matchesSummary(purchase: ImportPurchase) {
  const totals = previewTotals(purchase);
  return (Object.keys(totals) as Array<keyof ExpectedSummary>).every((key) =>
    purchase.summary[key] === null || Math.abs(totals[key] - purchase.summary[key]!) <= 0.01,
  );
}

function responseError(value: unknown) {
  if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") {
    return value.error;
  }
  return "No se pudo procesar la importación.";
}

export function PurchaseXlsxImporter({ branch, enabled, catalogReady, catalogMessage, products, suppliers }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PurchaseImportPreviewResponse | null>(null);
  const [purchases, setPurchases] = useState<ImportPurchase[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [submitTotal, setSubmitTotal] = useState(0);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);

  const productOptions = useMemo(() => products.map((product) => ({
    value: String(product.id),
    label: `${product.codigo ?? "Sin clave"} — ${product.nombre}`,
  })), [products]);
  const supplierOptions = useMemo(() => suppliers.map((supplier) => ({
    value: String(supplier.id),
    label: supplier.nombre ?? `Proveedor #${supplier.id}`,
  })), [suppliers]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.currentTarget.files?.[0] ?? null;
    setFile(selected);
    setPreview(null);
    setPurchases([]);
  };

  const preparePreview = async () => {
    if (!enabled || !branch) {
      notify.error("Selecciona una sucursal donde tengas permiso de captura.");
      return;
    }
    if (!catalogReady) {
      notify.error("Espera a que se carguen los catálogos de la sucursal.");
      return;
    }
    if (!file) {
      notify.error("Selecciona un archivo XLSX.");
      return;
    }

    const formData = new FormData();
    formData.set("schemaName", branch);
    formData.set("file", file, file.name);
    setLoading(true);
    try {
      const response = await fetch("/api/purchases/import-xlsx/preview", { method: "POST", body: formData });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        notify.error(responseError(payload));
        return;
      }
      const parsed = payload as PurchaseImportPreviewResponse;
      if (!Array.isArray(parsed.purchases) || parsed.purchases.length === 0) {
        notify.error("El archivo no contiene compras reconocibles.");
        return;
      }
      setPreview(parsed);
      setPurchases(parsed.purchases.map((draft) => createPurchasePreview(
        draft,
        products,
        suppliers,
        parsed.equivalences ?? [],
        parsed.departments ?? [],
      )));
      notify.success(`Se encontraron ${parsed.purchases.length} compra(s) para revisar.`);
    } catch {
      notify.error("No se pudo conectar con el servicio de importación XLSX.");
    } finally {
      setLoading(false);
    }
  };

  const updatePurchase = (jobId: string, update: (purchase: ImportPurchase) => ImportPurchase) => {
    setPurchases((current) => current.map((purchase) => purchase.draft.jobId === jobId ? update(purchase) : purchase));
  };

  const updateLine = (jobId: string, lineKey: string, update: (line: ImportLine) => ImportLine) => {
    updatePurchase(jobId, (purchase) => ({
      ...purchase,
      confirmed: false,
      submitResult: null,
      lines: purchase.lines.map((line) => line.key === lineKey ? update(line) : line),
    }));
  };

  const selectProduct = (purchase: ImportPurchase, line: ImportLine, value: string) => {
    const product = products.find((item) => String(item.id) === value);
    if (!product || !preview) return;
    const equivalence = matchingEquivalence(line.sourceDescription, product.id, preview.equivalences);
    const warnings = line.warnings.filter((warning) =>
      !warning.includes("clave") && !warning.includes("equivalencia") && !warning.includes("factor correcto"),
    );
    if (!equivalence.matched) warnings.push("No se encontró equivalencia; se usará factor 1.");
    if (equivalence.ambiguous) warnings.push("Hay equivalencias con igual longitud y distintos factores; indica el factor correcto.");
    updateLine(purchase.draft.jobId, line.key, (current) => ({
      ...current,
      productId: product.id,
      productName: product.nombre,
      departmentName: preview.departments.find((department) => department.id === product.departamento)?.nombre ?? "",
      unit: product.unidad,
      equivalenceFactor: equivalence.factor,
      equivalenceName: equivalence.name,
      equivalenceAmbiguous: equivalence.ambiguous,
      quantity: roundMoney(current.sourceQuantity * equivalence.factor),
      warnings,
    }));
    setEditingProduct(null);
  };

  const submitPurchases = async (retryOnlyFailed = false) => {
    if (!preview || !enabled || !branch || submitting) return;
    const jobIdRemap = new Map<string, string>();
    const queue = purchases.filter((purchase) => {
      if (retryOnlyFailed && (!purchase.submitResult || purchase.submitResult.ok)) return false;
      return true;
    }).map((purchase) => {
      if (purchase.submitResult?.status !== "failed") return purchase;
      const jobId = newJobId();
      jobIdRemap.set(purchase.draft.jobId, jobId);
      return { ...purchase, draft: { ...purchase.draft, jobId }, submitResult: null };
    });
    if (queue.length === 0) {
      notify.info("No hay compras pendientes de reintento.");
      return;
    }
    const notReady = queue.find((purchase) =>
      !purchase.supplierId || !purchase.draft.purchaseDate || !purchase.draft.ticketNumber ||
      purchase.lines.length === 0 || purchase.lines.length > 500 || purchase.lines.some((line) => !line.productId || line.equivalenceAmbiguous || !Number.isFinite(line.quantity) || !Number.isFinite(line.subtotal) || !Number.isFinite(line.discount) || !Number.isFinite(line.taxes) || line.quantity <= 0 || line.subtotal < 0 || line.discount < 0 || line.taxes < 0 || line.discount > line.subtotal + line.taxes) ||
      !purchase.confirmed || !matchesSummary(purchase),
    );
    if (notReady) {
      notify.error(`Revisa proveedor, productos, importes y confirmaciones de la compra ${notReady.draft.ticketNumber || "sin folio"}.`);
      return;
    }

    setSubmitting(true);
    setProgress(0);
    setSubmitTotal(queue.length);
    setPurchases((current) => current.map((purchase) => {
      const nextJobId = jobIdRemap.get(purchase.draft.jobId);
      return nextJobId ? { ...purchase, draft: { ...purchase.draft, jobId: nextJobId }, submitResult: null } : purchase;
    }));
    const allResults: PurchaseImportSubmitResult[] = [];
    try {
      for (let start = 0; start < queue.length; start += 10) {
        const chunk = queue.slice(start, start + 10);
        let chunkResults: PurchaseImportSubmitResult[];
        try {
          const response = await fetch("/api/purchases/import-xlsx/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              schemaName: branch,
              purchases: chunk.map((purchase) => ({
                jobId: purchase.draft.jobId,
                ticketNumber: purchase.draft.ticketNumber,
                purchaseDate: purchase.draft.purchaseDate,
                supplierId: purchase.supplierId,
                summary: purchase.summary,
                items: purchase.lines.map((line) => ({
                  productId: line.productId,
                  quantity: line.quantity,
                  subtotal: line.subtotal,
                  discount: line.discount,
                  taxes: line.taxes,
                })),
              })),
            }),
          });
          const payload = await response.json().catch(() => null) as { results?: PurchaseImportSubmitResult[]; error?: string } | null;
          if (!response.ok && !Array.isArray(payload?.results)) {
            chunkResults = chunk.map((purchase) => ({ jobId: purchase.draft.jobId, ok: false, error: payload?.error ?? "No se pudo enviar esta compra." }));
          } else {
            chunkResults = payload?.results ?? [];
          }
        } catch {
          chunkResults = chunk.map((purchase) => ({ jobId: purchase.draft.jobId, ok: false, error: "Se perdió la conexión; vuelve a intentar con el mismo identificador." }));
        }
        allResults.push(...chunkResults);
        setPurchases((current) => current.map((purchase) => {
          const result = chunkResults.find((item) => item.jobId === purchase.draft.jobId);
          return result ? { ...purchase, submitResult: result } : purchase;
        }));
        setProgress(Math.min(start + chunk.length, queue.length));
      }
      const successCount = allResults.filter((result) => result.ok).length;
      if (successCount === queue.length) notify.success(`Se encolaron ${successCount} compra(s) en ${branch}.`);
      else notify.error(`Se encolaron ${successCount} de ${queue.length} compras. Corrige o reintenta las restantes.`);
    } catch {
      notify.error("Se perdió la conexión al enviar el lote. Puedes reintentar con los mismos identificadores.");
    } finally {
      setSubmitting(false);
    }
  };

  const totalsFor = (purchase: ImportPurchase) => previewTotals(purchase);

  return (
    <section className="space-y-4" aria-label="Importación de compras desde Excel">
      <div className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3 p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-primary/10 p-3 text-primary"><FileSpreadsheet className="size-6" aria-hidden="true" /></span>
            <div>
              <h2 className="card-title">Importar compras desde Excel</h2>
              <p className="text-sm text-base-content/70">Carga el libro, revisa las coincidencias y confirma los importes antes de encolar.</p>
            </div>
          </div>
          <div className="join">
            <input
                id="purchase-xlsx-file"
                ref={inputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="file-input join-item rounded-l-full"
                disabled={!enabled || loading || submitting}
                onChange={handleFileChange}
            />
            <button type="button" className="btn btn-primary join-item rounded-r-full" disabled={!enabled || !catalogReady || !file || loading || submitting} onClick={() => void preparePreview()}>
              {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <ScanEye className="size-4" aria-hidden="true" />}
              {loading ? "Leyendo archivo..." : "Preparar vista previa"}
            </button>
          </div>
          <div className="w-full">
            <fieldset className="fieldset min-w-0">
              <legend className="fieldset-legend"><label htmlFor="purchase-xlsx-file">Archivo XLSX</label></legend>

              <p className="label text-base-content/60">Máximo 20 MiB. Se procesará el documento de Excel para poder previsualizar las compras.</p>
            </fieldset>
          </div>
          {!catalogReady && enabled ? <p className="text-sm text-warning">{catalogMessage || "Cargando los productos y proveedores de la sucursal..."}</p> : null}
          {file ? <p className="truncate text-xs text-base-content/60">{file.name}</p> : null}
        </div>
      </div>

      {preview ? (
        <>
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-xl font-semibold">{purchases.length} compra(s) detectada(s)</h2>
              <p className="text-sm text-base-content/70">Libro: {preview.fileName}. Cada folio se encola como un trabajo independiente.</p>
            </div>
            <div className="flex gap-2">
              {purchases.some((purchase) => purchase.submitResult && !purchase.submitResult.ok) ? (
                <button type="button" className="btn btn-outline rounded-full" disabled={submitting} onClick={() => void submitPurchases(true)}>
                  <RotateCw className="size-4" aria-hidden="true" /> Reintentar fallidas
                </button>
              ) : null}
              <button type="button" className="btn btn-primary rounded-full" disabled={!enabled || submitting} onClick={() => void submitPurchases()}>
                {submitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
                {submitting ? `Enviando ${progress} de ${purchases.length}...` : "Encolar compras revisadas"}
              </button>
            </div>
          </div>

          {purchases.map((purchase) => {
            const totals = totalsFor(purchase);
            const hasBlockingIdentity = !purchase.draft.purchaseDate || !purchase.draft.ticketNumber;
            const summaryMatches = matchesSummary(purchase);
            return (
              <article key={purchase.draft.jobId} className="card border border-base-300 bg-base-100 shadow-sm">
                <div className="card-body gap-4 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="card-title">Folio {purchase.draft.ticketNumber || "pendiente"}</h3>
                      <p className="text-xs text-base-content/60">{purchase.draft.sourceSheet} · filas {purchase.draft.sourceRows.join(", ")}</p>
                      <p className="mt-1 text-xs text-base-content/70">Pago: Crédito · Facturado: No · Fecha de recepción: {purchase.draft.purchaseDate || "pendiente"}</p>
                    </div>
                    {purchase.submitResult ? (
                      <span className={`badge badge-sm rounded-full ${purchase.submitResult.ok ? "badge-success" : "badge-error"}`}>
                        {purchase.submitResult.ok ? purchase.submitResult.status ?? "Encolada" : "No encolada"}
                      </span>
                    ) : <span className="badge badge-sm badge-outline rounded-full">Vista previa</span>}
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <fieldset className="fieldset min-w-0">
                      <legend className="fieldset-legend"><label htmlFor={`supplier-${purchase.draft.jobId}`}>Proveedor</label></legend>
                      <AutocompleteSelect
                        id={`supplier-${purchase.draft.jobId}`}
                        value={purchase.supplierId ? String(purchase.supplierId) : ""}
                        options={supplierOptions}
                        placeholder="Busca un proveedor activo"
                        disabled={submitting || Boolean(purchase.submitResult?.ok)}
                        onChange={(value) => updatePurchase(purchase.draft.jobId, (current) => ({
                          ...current,
                          supplierId: value ? Number(value) : null,
                          confirmed: false,
                          submitResult: null,
                        }))}
                      />
                    </fieldset>
                    <label className="fieldset">
                      <span className="fieldset-legend">Fecha</span>
                      <input type="date" className="input w-full border-base-300" value={purchase.draft.purchaseDate} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => updatePurchase(purchase.draft.jobId, (current) => ({
                        ...current,
                        draft: { ...current.draft, purchaseDate: event.target.value },
                        confirmed: false,
                        submitResult: null,
                      }))} />
                    </label>
                    <label className="fieldset">
                      <span className="fieldset-legend">No. Ticket</span>
                      <input type="text" className="input w-full border-base-300" value={purchase.draft.ticketNumber} maxLength={50} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => updatePurchase(purchase.draft.jobId, (current) => ({
                        ...current,
                        draft: { ...current.draft, ticketNumber: event.target.value.replace(/[^A-Za-z0-9_#-]/g, "").slice(0, 50) },
                        confirmed: false,
                        submitResult: null,
                      }))} />
                    </label>
                  </div>

                  <div className="overflow-x-auto rounded-box border border-base-300">
                    <table className="table table-sm min-w-[1100px]">
                      <thead>
                        <tr>
                          <th>Clave / producto local</th><th>Departamento local</th><th>Descripción Excel</th><th>Cant. origen</th><th>Factor</th><th>Cantidad inventario</th><th>Unidad</th><th>Subtotal</th><th>Descuento</th><th>Impuestos</th><th>Importe</th>
                        </tr>
                      </thead>
                      <tbody>
                        {purchase.lines.map((line) => {
                          const lineAmount = roundMoney(roundMoney(line.subtotal) - roundMoney(line.discount) + roundMoney(line.taxes));
                          const productSelect = !line.productId || editingProduct === line.key;
                          return (
                            <tr key={line.key}>
                              <td className="min-w-64">
                                <span className="mb-1 block text-xs text-base-content/60">{line.sourceCode}</span>
                                {productSelect ? (
                                  <AutocompleteSelect
                                    id={`product-${line.key}`}
                                    value={line.productId ? String(line.productId) : ""}
                                    options={productOptions}
                                    placeholder="Busca el producto por clave o nombre"
                                    disabled={submitting || Boolean(purchase.submitResult?.ok)}
                                    onChange={(value) => selectProduct(purchase, line, value)}
                                  />
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm">{line.productName}</span>
                                    <button type="button" className="btn btn-ghost btn-xs" disabled={submitting || Boolean(purchase.submitResult?.ok)} onClick={() => setEditingProduct(line.key)}>Cambiar</button>
                                  </div>
                                )}
                              </td>
                              <td>{line.departmentName || "—"}</td>
                              <td className="max-w-56 whitespace-normal text-xs">{line.sourceDescription}<span className="mt-1 block text-base-content/50">Línea Excel: {line.spreadsheetLine || "—"}</span></td>
                              <td className="text-right">{line.sourceQuantity}</td>
                              <td className="min-w-24">
                                {line.equivalenceAmbiguous ? (
                                  <input type="number" min="0.000001" step="any" className="input input-sm w-24 text-right" value={line.equivalenceFactor} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => {
                                    const factor = Number(event.target.value);
                                    updateLine(purchase.draft.jobId, line.key, (current) => ({ ...current, equivalenceFactor: factor, quantity: roundMoney(current.sourceQuantity * factor), equivalenceAmbiguous: false, warnings: current.warnings.filter((warning) => !warning.includes("distintos factores")) }));
                                  }} />
                                ) : <span title={line.equivalenceName ?? "Sin equivalencia"}>{line.equivalenceFactor}</span>}
                              </td>
                              <td><input type="number" min="0.000001" step="any" className="input input-sm w-28 text-right" value={line.quantity} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => updateLine(purchase.draft.jobId, line.key, (current) => ({ ...current, quantity: Number(event.target.value) }))} /></td>
                              <td>{line.unit || "—"}</td>
                              <td><input type="number" min="0" step="0.01" className="input input-sm w-32 text-right" value={line.subtotal} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => updateLine(purchase.draft.jobId, line.key, (current) => ({ ...current, subtotal: Number(event.target.value) }))} /></td>
                              <td><input type="number" min="0" step="0.01" className="input input-sm w-32 text-right" value={line.discount} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => updateLine(purchase.draft.jobId, line.key, (current) => ({ ...current, discount: Number(event.target.value) }))} /></td>
                              <td><input type="number" min="0" step="0.01" className="input input-sm w-32 text-right" value={line.taxes} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => updateLine(purchase.draft.jobId, line.key, (current) => ({ ...current, taxes: Number(event.target.value) }))} /></td>
                              <td className="text-right font-medium">{money(lineAmount)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="space-y-2">
                      {purchase.warnings.map((warning) => <p key={warning} className="alert alert-warning py-2 text-sm">{warning}</p>)}
                      {purchase.lines.flatMap((line) => line.warnings.map((warning) => <p key={`${line.key}-${warning}`} className="alert alert-warning py-2 text-sm">Fila {line.sourceRow}: {warning}</p>))}
                      {hasBlockingIdentity ? <p className="alert alert-error py-2 text-sm">Completa la fecha y el folio para enviar.</p> : null}
                      {purchase.lines.length > 500 ? <p className="alert alert-error py-2 text-sm">La compra excede el límite actual de 500 productos por folio.</p> : null}
                      {!summaryMatches ? <p className="alert alert-error py-2 text-sm">Los importes editados aún no cuadran con el resumen del Excel.</p> : null}
                      <label className="label cursor-pointer justify-start gap-2">
                        <input type="checkbox" className="checkbox checkbox-sm checkbox-primary" checked={purchase.confirmed} disabled={submitting || Boolean(purchase.submitResult?.ok)} onChange={(event) => updatePurchase(purchase.draft.jobId, (current) => ({ ...current, confirmed: event.target.checked }))} />
                        <span className="text-sm">Revisé las coincidencias, equivalencias y advertencias de esta compra.</span>
                      </label>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-5 gap-y-1 rounded-box bg-base-200 p-3 text-sm">
                      <dt>Subtotal</dt><dd className="text-right">{money(totals.subtotal)}</dd>
                      <dt>Resumen subtotal</dt><dd className="text-right">{purchase.summary.subtotal === null ? "—" : money(purchase.summary.subtotal)}</dd>
                      <dt>Descuentos</dt><dd className="text-right">{money(totals.discount)}</dd>
                      <dt>Resumen descuentos</dt><dd className="text-right">{purchase.summary.discount === null ? "—" : money(purchase.summary.discount)}</dd>
                      <dt>Impuestos</dt><dd className="text-right">{money(totals.taxes)}</dd>
                      <dt>Resumen impuestos</dt><dd className="text-right">{purchase.summary.taxes === null ? "—" : money(purchase.summary.taxes)}</dd>
                      <dt className="font-bold">Total</dt><dd className="text-right font-bold">{money(totals.total)}</dd>
                      <dt>Resumen Excel</dt><dd className="text-right">{purchase.summary.total === null ? "—" : money(purchase.summary.total)}</dd>
                    </dl>
                  </div>
                  {purchase.submitResult && !purchase.submitResult.ok ? <p className="alert alert-error py-2 text-sm">{purchase.submitResult.error}</p> : null}
                  {purchase.submitResult?.ok ? <p className="alert alert-success py-2 text-sm">Compra enviada a la cola con estatus {purchase.submitResult.status}.</p> : null}
                </div>
              </article>
            );
          })}
        </>
      ) : null}

      {submitting ? (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-base-100/90 px-4 backdrop-blur-sm" role="status" aria-live="assertive" aria-atomic="true">
          <div className="card w-full max-w-md border border-base-300 bg-base-100 shadow-2xl">
            <div className="card-body items-center gap-4 p-8 text-center">
              <LoaderCircle className="size-12 animate-spin text-primary" aria-hidden="true" />
              <div>
                <h2 className="text-xl font-semibold">Encolando compras en Supabase</h2>
                <p className="mt-2 text-sm text-base-content/70">Se han procesado {progress} de {submitTotal} compras. El proceso continúa en segundo plano en cada sucursal.</p>
              </div>
              <progress className="progress progress-primary w-full" max={Math.max(submitTotal, 1)} value={progress} />
              <p className="text-xs text-base-content/60">Mantén esta página abierta mientras termina el envío.</p>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
