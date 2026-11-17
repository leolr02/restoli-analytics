"use client";

import { FileSpreadsheet, LoaderCircle, PackageOpen, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { AutocompleteSelect } from "@/components/autocomplete-select";
import { PurchaseHistory } from "@/components/purchase-history";
import { PurchaseXlsxImporter } from "@/components/purchase-xlsx-importer";
import { usePurchaseView } from "@/components/protected-shell";
import {
  loadPurchaseCatalogs,
  type CatalogQueryError,
  type PurchaseCatalogs,
  type PurchaseProduct,
} from "@/lib/purchase-catalogs";
import { notify } from "@/lib/notifications";

type EntryMode = "manual" | "template";
type LineEditField = "quantity" | "subtotal" | "discount" | "taxes";
type PurchaseLine = {
  key: string;
  productId: number;
  productName: string;
  quantity: string;
  unit: string;
  subtotal: string;
  discount: string;
  taxes: string;
};
type ActiveCell = { lineKey: string; field: LineEditField };
type CatalogState = PurchaseCatalogs & { loading: boolean };

const EMPTY_CATALOG: CatalogState = {
  suppliers: [],
  products: [],
  loading: false,
  supplierError: null as CatalogQueryError | null,
  productError: null as CatalogQueryError | null,
  cacheWarning: false,
};

const LINE_EDIT_ORDER: LineEditField[] = ["quantity", "subtotal", "discount", "taxes"];
const CURRENCY_FRACTION_DIGITS: Intl.NumberFormatOptions = {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
};

function formatBranchLabel(schemaName: string) {
  const label = schemaName.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function catalogErrorMessage(catalogName: string, error: CatalogQueryError | null) {
  if (!error) return null;
  if (error.code === "PGRST106") {
    return "El esquema de esta sucursal no está habilitado en Exposed schemas de Supabase API.";
  }
  if (error.code === "42501") {
    return `Supabase rechazó la lectura de ${catalogName}. Revisa que el navegador envíe la sesión authenticated de root y los permisos RLS.`;
  }
  if (error.code === "NETWORK") {
    return `No se pudo conectar para consultar ${catalogName}.`;
  }
  return `No se pudo consultar ${catalogName}. Código de Supabase: ${error.code}.`;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatMoney(value: number) {
  return value.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
    ...CURRENCY_FRACTION_DIGITS,
  });
}

function getCurrentLocalDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function evaluateArithmeticExpression(expression: string): number | null {
  const source = expression.replace(/\s+/g, "");
  if (!source || !/^[\d.+\-*\/()]+$/.test(source)) return null;

  let cursor = 0;

  const parseExpression = (): number => {
    let value = parseTerm();
    while (source[cursor] === "+" || source[cursor] === "-") {
      const operator = source[cursor++];
      const next = parseTerm();
      value = operator === "+" ? value + next : value - next;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseUnary();
    while (source[cursor] === "*" || source[cursor] === "/") {
      const operator = source[cursor++];
      const next = parseUnary();
      if (operator === "/" && next === 0) throw new Error("División entre cero.");
      value = operator === "*" ? value * next : value / next;
    }
    return value;
  };

  const parseUnary = (): number => {
    if (source[cursor] === "+") {
      cursor += 1;
      return parseUnary();
    }
    if (source[cursor] === "-") {
      cursor += 1;
      return -parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    if (source[cursor] === "(") {
      cursor += 1;
      const value = parseExpression();
      if (source[cursor] !== ")") throw new Error("Paréntesis incompletos.");
      cursor += 1;
      return value;
    }

    const number = source.slice(cursor).match(/^(?:\d+(?:\.\d*)?|\.\d+)/)?.[0];
    if (!number) throw new Error("La expresión no es válida.");
    cursor += number.length;
    return Number(number);
  };

  try {
    const result = parseExpression();
    return cursor === source.length && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function lineValue(line: PurchaseLine, field: LineEditField) {
  return Number(line[field] || 0);
}

function lineImport(line: PurchaseLine) {
  return roundMoney(
    lineValue(line, "subtotal") -
      lineValue(line, "discount") +
      lineValue(line, "taxes"),
  );
}

function createLineKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function createPurchaseRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizePersonName(value: string) {
  return value.replace(/[^\p{L}\p{N}@# ]/gu, "");
}

function sanitizeNotes(value: string) {
  return value.replace(/[^\p{L}\p{N},#@* \r\n]/gu, "");
}

function sanitizeDecimal(value: string) {
  const numeric = value.replace(/[^\d.]/g, "");
  const [whole, ...fraction] = numeric.split(".");
  return fraction.length > 0 ? `${whole}.${fraction.join("")}` : whole;
}

function Field({
  id,
  label,
  children,
  required = false,
  className = "",
}: {
  id: string;
  label: string;
  children: ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <fieldset className={`fieldset min-w-0 ${className}`}>
      <legend className="fieldset-legend">
        <label htmlFor={id}>{label}</label>
      </legend>
      {children}
      <p className={`label ${required ? "text-error" : "text-base-content/60"}`}>
        {required ? "Obligatorio" : "Opcional"}
      </p>
    </fieldset>
  );
}

export function PurchaseEntryForm({
  branchSchemas,
  writableSchemas,
  userId,
  userEmail,
}: {
  branchSchemas: string[];
  writableSchemas: string[];
  userId: string;
  userEmail: string;
}) {
  const { purchaseView } = usePurchaseView();
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<EntryMode>("manual");
  const [ticketNumber, setTicketNumber] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [purchaseDate, setPurchaseDate] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"EFECTIVO" | "CREDITO" | "">("");
  const [isInvoiced, setIsInvoiced] = useState<"A" | "P" | "">("");
  const [advance, setAdvance] = useState("");
  const [paymentDays, setPaymentDays] = useState("");
  const [receivedBy, setReceivedBy] = useState("");
  const [otherExpenses, setOtherExpenses] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [cellDraft, setCellDraft] = useState("");
  const [catalog, setCatalog] = useState<CatalogState>(EMPTY_CATALOG);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const submissionIdRef = useRef<string | null>(null);
  const focusProductAfterCell = useRef(false);
  const formEnabled = Boolean(branch) && writableSchemas.includes(branch);
  const suppliers = catalog.suppliers;
  const products = catalog.products;
  const catalogLoading = Boolean(branch) && catalog.loading;

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => sum + lineValue(line, "subtotal"), 0);
    const discount = lines.reduce((sum, line) => sum + lineValue(line, "discount"), 0);
    const taxes = lines.reduce((sum, line) => sum + lineValue(line, "taxes"), 0);
    const lineImports = lines.reduce((sum, line) => sum + lineImport(line), 0);
    return {
      subtotal: roundMoney(subtotal),
      discount: roundMoney(discount),
      taxes: roundMoney(taxes),
      total: roundMoney(
        lineImports +
          (Number.isFinite(Number(otherExpenses)) ? Number(otherExpenses || 0) : 0),
      ),
    };
  }, [lines, otherExpenses]);

  useEffect(() => {
    setPurchaseDate(getCurrentLocalDate());
  }, []);

  useEffect(() => {
    setSupplierId("");
    setLines([]);
    setActiveCell(null);

    if (!branch) {
      setCatalog(EMPTY_CATALOG);
      return;
    }

    let active = true;
    setCatalog({ ...EMPTY_CATALOG, loading: true });

    void loadPurchaseCatalogs(userId, branch)
      .then((result) => {
        if (active) setCatalog({ ...result, loading: false });
      })
      .catch(() => {
        if (!active) return;
        setCatalog({
          ...EMPTY_CATALOG,
          productError: { code: "NETWORK", message: "No se pudo cargar el catálogo." },
          supplierError: { code: "NETWORK", message: "No se pudo cargar el catálogo." },
        });
      });

    return () => {
      active = false;
    };
  }, [branch, userId]);

  useEffect(() => {
    if (activeCell) {
      const input = document.getElementById(
        `line-${activeCell.lineKey}-${activeCell.field}`,
      ) as HTMLInputElement | null;
      input?.focus();
      input?.select();
      return;
    }

    if (focusProductAfterCell.current) {
      focusProductAfterCell.current = false;
      window.requestAnimationFrame(() => document.getElementById("product")?.focus());
    }
  }, [activeCell]);

  const handleBranchChange = (schemaName: string) => {
    setBranch(schemaName);
    submissionIdRef.current = null;
    setTicketNumber("");
    setInvoiceNumber("");
    setAttachment(null);
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    setPurchaseDate(getCurrentLocalDate());
    setSupplierId("");
    setPaymentMethod("");
    setIsInvoiced("");
    setAdvance("");
    setPaymentDays("");
    setReceivedBy("");
    setOtherExpenses("");
    setNotes("");
    setLines([]);
    setActiveCell(null);
  };

  const handleProductSelect = (value: string) => {
    const product = products.find((item) => String(item.id) === value);
    if (!product) return;

    const key = createLineKey();
    setLines((current) => [
      ...current,
      {
        key,
        productId: product.id,
        productName: product.nombre,
        quantity: "1",
        unit: product.unidad,
        subtotal: "0.00",
        discount: "0.00",
        taxes: "0.00",
      },
    ]);
    setCellDraft("1");
    setActiveCell({ lineKey: key, field: "quantity" });
  };

  const confirmActiveCell = (requestedNextField?: LineEditField) => {
    if (!activeCell) return;
    const line = lines.find((item) => item.key === activeCell.lineKey);
    if (!line) return;

    const rawValue = cellDraft.trim();
    const parsedValue = rawValue === "" && activeCell.field !== "quantity"
      ? 0
      : evaluateArithmeticExpression(rawValue);
    if (parsedValue === null || parsedValue < 0 || (activeCell.field === "quantity" && parsedValue === 0)) {
      notify.error(activeCell.field === "quantity"
        ? "Ingresa una operación válida; la cantidad debe ser mayor que cero."
        : "Ingresa una operación válida con resultado igual o mayor que cero.");
      return;
    }

    const savedValue = activeCell.field === "quantity"
      ? String(parsedValue)
      : roundMoney(parsedValue).toFixed(2);
    const currentIndex = LINE_EDIT_ORDER.indexOf(activeCell.field);
    const nextField = requestedNextField ?? LINE_EDIT_ORDER[currentIndex + 1];
    if (requestedNextField && requestedNextField !== LINE_EDIT_ORDER[currentIndex + 1]) return;

    setLines((current) => current.map((item) =>
      item.key === activeCell.lineKey
        ? { ...item, [activeCell.field]: savedValue }
        : item,
    ));

    if (nextField) {
      setCellDraft(line[nextField]);
      setActiveCell({ lineKey: activeCell.lineKey, field: nextField });
    } else {
      focusProductAfterCell.current = true;
      setActiveCell(null);
    }
  };

  const handleCellClick = (line: PurchaseLine, field: LineEditField) => {
    if (!activeCell) {
      setCellDraft(line[field]);
      setActiveCell({ lineKey: line.key, field });
      return;
    }
    if (activeCell.lineKey !== line.key) return;
    const activeIndex = LINE_EDIT_ORDER.indexOf(activeCell.field);
    if (LINE_EDIT_ORDER[activeIndex + 1] === field) confirmActiveCell(field);
  };

  const removeLine = (lineKey: string) => {
    setLines((current) => current.filter((line) => line.key !== lineKey));
    if (activeCell?.lineKey === lineKey) {
      focusProductAfterCell.current = true;
      setActiveCell(null);
    }
  };

  const handleAttachmentChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    if (!file) {
      setAttachment(null);
      return;
    }

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["png", "jpg", "jpeg", "pdf", "xml"].includes(extension)) {
      notify.error("El documento debe ser PNG, JPG, JPEG, PDF o XML.");
      setAttachment(null);
      event.currentTarget.value = "";
      return;
    }
    setAttachment(file);
  };

  const resetPurchaseFields = () => {
    submissionIdRef.current = null;
    setTicketNumber("");
    setInvoiceNumber("");
    setAttachment(null);
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    setPurchaseDate(getCurrentLocalDate());
    setSupplierId("");
    setPaymentMethod("");
    setIsInvoiced("");
    setAdvance("");
    setPaymentDays("");
    setReceivedBy("");
    setOtherExpenses("");
    setNotes("");
    setLines([]);
    setActiveCell(null);
    setCellDraft("");
    focusProductAfterCell.current = false;
  };

  const handlePurchaseSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!formEnabled || !branch) {
      notify.error("No tienes permiso para registrar compras en esta sucursal.");
      return;
    }
    if (activeCell) {
      notify.error("Confirma primero el valor de la celda que estás editando.");
      return;
    }
    if (!supplierId || !paymentMethod || !isInvoiced || lines.length === 0) {
      notify.error("Completa proveedor, pago, facturación y agrega al menos un producto.");
      return;
    }

    const formData = new FormData();
    submissionIdRef.current ??= createPurchaseRequestId();
    formData.set("jobId", submissionIdRef.current);
    formData.set("schemaName", branch);
    formData.set("headerPayload", JSON.stringify({
      ticket_number: ticketNumber.trim() || null,
      invoice_number: invoiceNumber.trim() || null,
      purchase_date: purchaseDate,
      supplier_id: Number(supplierId),
      payment_method: paymentMethod,
      invoiced_status: isInvoiced,
      advance: Number(advance || 0),
      payment_days: paymentDays === "" ? null : Number(paymentDays),
      received_by: receivedBy.trim() || userEmail,
      other_expenses: Number(otherExpenses || 0),
      notes,
    }));
    formData.set("itemsPayload", JSON.stringify(lines.map((line) => ({
      product_id: line.productId,
      quantity: Number(line.quantity),
      subtotal: Number(line.subtotal),
      discount: Number(line.discount),
      taxes: Number(line.taxes),
    }))));
    if (attachment) formData.set("attachment", attachment, attachment.name);

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/purchases", {
        method: "POST",
        body: formData,
      });
      const result: unknown = await response.json().catch(() => null);
      const errorMessage =
        typeof result === "object" && result !== null && "error" in result &&
        typeof result.error === "string"
          ? result.error
          : "No se pudo registrar la compra.";

      if (!response.ok) {
        notify.error(errorMessage);
        return;
      }

      notify.success(`Compra enviada a la cola de ${formatBranchLabel(branch)}.`);
      resetPurchaseFields();
    } catch {
      notify.error("No se pudo conectar con el servicio de compras.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderLineCell = (line: PurchaseLine, field: LineEditField) => {
    const isActive = activeCell?.lineKey === line.key && activeCell.field === field;
    const activeIndex = activeCell ? LINE_EDIT_ORDER.indexOf(activeCell.field) : -1;
    const isNextCell =
      activeCell?.lineKey === line.key && LINE_EDIT_ORDER[activeIndex + 1] === field;
    const isMoney = field !== "quantity";
    const fieldLabel = {
      quantity: "cantidad",
      subtotal: "subtotal",
      discount: "descuento",
      taxes: "impuestos",
    }[field];

    return (
      <td className="min-w-28 text-right" key={field}>
        {isActive ? (
          <input
            id={`line-${line.key}-${field}`}
            type="text"
            inputMode="text"
            className="input input-sm w-full min-w-0 border-base-300 bg-base-100 text-right"
            value={cellDraft}
            aria-label={`${fieldLabel} de ${line.productName}`}
            title="Puedes escribir una operación, por ejemplo: 2 * 3 + 1"
            onChange={(event) => setCellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                confirmActiveCell();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-h-9 w-full rounded-field px-2 text-right hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(activeCell) && !isNextCell}
            aria-label={`Editar ${fieldLabel} de ${line.productName}`}
            onClick={() => handleCellClick(line, field)}
          >
            {isMoney ? formatMoney(lineValue(line, field)) : line.quantity}
          </button>
        )}
      </td>
    );
  };

  return (
    <section
      id="purchase-module-panel"
      role="tabpanel"
      aria-label={purchaseView === "new" ? "Nueva compra" : "Historial de compras"}
      className="mx-auto w-full max-w-[1600px] space-y-2 p-2"
    >
      {purchaseView === "history" ? (
        <PurchaseHistory />
      ) : (
        <>
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
        <div>
          <h1 className="mt-1 text-3xl font-bold text-primary/70">Compras</h1>
          <p className="mt-1 text-base-content/70">
            Registro de compras.
          </p>
        </div>
        <div className="flex w-full overflow-hidden rounded-full border border-base-300 sm:w-auto" role="tablist" aria-label="Forma de captura">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "manual"}
            className={`btn h-auto min-h-12 flex-1 rounded-none border-0 px-3 sm:flex-none ${mode === "manual" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMode("manual")}
          >
            Captura manual
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "template"}
            className={`btn h-auto min-h-12 flex-1 rounded-none border-0 px-3 sm:flex-none ${mode === "template" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMode("template")}
          >
            <FileSpreadsheet className="size-4" aria-hidden="true" />
            Plantilla XLSX
          </button>
        </div>
      </div>

      <div className="card border border-base-300 bg-primary/10 shadow-sm">
        <div className="card-body gap-3 p-4">
          <div>
            <h2 className="card-title text-lg">Sucursal de destino</h2>
            <p className="text-sm text-base-content/70">
              Selecciona la sucursal donde se registrará la compra. Es obligatorio para habilitar el formulario.
            </p>
          </div>
          <Field id="branch" label="Sucursal" required className="max-w-xl">
            <AutocompleteSelect
              id="branch"
              value={branch}
              options={branchSchemas.map((schemaName) => ({
                value: schemaName,
                label: formatBranchLabel(schemaName),
              }))}
              placeholder={
                branchSchemas.length === 0
                  ? "No tienes sucursales disponibles"
                  : "Busca o selecciona una sucursal"
              }
              emptyMessage="No hay sucursales coincidentes"
              onChange={handleBranchChange}
              disabled={branchSchemas.length === 0}
            />
          </Field>
          <p className="text-xs text-base-content/60">
            Las sucursales disponibles dependen de tu perfil de acceso.
          </p>
          {branch && !writableSchemas.includes(branch) ? (
            <p className="text-xs text-warning">
              Tu perfil tiene acceso de solo lectura a esta sucursal.
            </p>
          ) : null}
        </div>
      </div>

      {mode === "template" ? (
        <PurchaseXlsxImporter
          key={`${branch}-${mode}`}
          branch={branch}
          enabled={formEnabled}
          catalogReady={!catalogLoading && !catalog.productError && !catalog.supplierError}
          catalogMessage={
            catalogLoading
              ? "Cargando los productos y proveedores de la sucursal..."
              : catalogErrorMessage("productos", catalog.productError) ??
                catalogErrorMessage("proveedores", catalog.supplierError) ??
                ""
          }
          products={products}
          suppliers={suppliers}
        />
      ) : (
        <form onSubmit={handlePurchaseSubmit}>
        <fieldset disabled={!formEnabled || isSubmitting} className="min-w-0 space-y-6 disabled:opacity-75">
          <div className="grid grid-cols-1 items-start gap-2 xl:grid-cols-12">
            <section className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-4">
              <div className="card-body gap-4 p-4 sm:p-5">
                <div>
                  <h2 className="card-title">Datos de compra</h2>
                  <p className="text-sm font-light text-base-content/70">
                    Información general del documento y su recepción.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field id="ticket-number" label="No. Ticket">
                    <input
                      id="ticket-number"
                      className="input w-full border-base-300 bg-base-100"
                      value={ticketNumber}
                      minLength={3}
                      maxLength={50}
                      pattern="[A-Za-z0-9_#-]{3,50}"
                      title="De 3 a 50 caracteres: letras, números, guion bajo, guion y #."
                      onChange={(event) =>
                        setTicketNumber(event.target.value.replace(/[^A-Za-z0-9_#-]/g, "").slice(0, 50))
                      }
                    />
                  </Field>
                  <Field id="invoice-number" label="No. Factura">
                    <input
                      id="invoice-number"
                      className="input w-full border-base-300 bg-base-100"
                      value={invoiceNumber}
                      minLength={3}
                      maxLength={80}
                      pattern="[A-Za-z0-9_#-]{3,80}"
                      title="De 3 a 80 caracteres: letras, números, guion bajo, guion y #."
                      onChange={(event) =>
                        setInvoiceNumber(event.target.value.replace(/[^A-Za-z0-9_#-]/g, "").slice(0, 80))
                      }
                    />
                  </Field>
                  <Field id="purchase-document" label="Documento de compra" className="sm:col-span-2">
                    <input
                      id="purchase-document"
                      type="file"
                      accept=".png,.jpg,.jpeg,.pdf,.xml,image/png,image/jpeg,application/pdf,application/xml,text/xml"
                      className="file-input w-full border-base-300 bg-base-100"
                      ref={attachmentInputRef}
                      onChange={handleAttachmentChange}
                    />
                    {attachment ? (
                      <span className="mt-1 truncate text-xs text-base-content/60">{attachment.name}</span>
                    ) : null}
                  </Field>
                  <Field id="purchase-date" label="Fecha" required>
                    <input
                      id="purchase-date"
                      className="input w-full border-base-300 bg-base-100"
                      type="date"
                      value={purchaseDate}
                      onChange={(event) => setPurchaseDate(event.target.value)}
                      required
                    />
                  </Field>
                  <Field id="supplier" label="Proveedor" className="col-span-2" required>
                    <AutocompleteSelect
                      id="supplier"
                      value={supplierId}
                      options={suppliers.filter((supplier) => supplier.nombre).map((supplier) => ({
                        value: String(supplier.id),
                        label: supplier.nombre as string,
                      }))}
                      placeholder={
                        !branch
                          ? "Selecciona una sucursal primero"
                          : catalogLoading
                            ? "Cargando proveedores..."
                            : catalog.supplierError
                              ? "No se pudieron cargar los proveedores"
                              : suppliers.length === 0
                                ? "Sin proveedores visibles para esta sucursal"
                                : "Busca o selecciona un proveedor"
                      }
                      emptyMessage={
                        catalog.supplierError
                          ? "No se pudieron cargar los proveedores"
                          : "Sin proveedores visibles para esta sucursal"
                      }
                      onChange={setSupplierId}
                      disabled={!branch || catalogLoading || Boolean(catalog.supplierError) || suppliers.every((supplier) => !supplier.nombre)}
                      required
                    />
                    {catalogErrorMessage("proveedores", catalog.supplierError) ? (
                      <p role="alert" className="mt-1 text-xs text-error">
                        {catalogErrorMessage("proveedores", catalog.supplierError)}
                      </p>
                    ) : null}
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field id="payment-method" label="Pago" required className="border border-0.5 border-base-300 rounded-lg text-center px-2">
                    <div className="flex flex-wrap gap-x-2 gap-y-2 justify-center">
                      <label className="label cursor-pointer justify-start gap-2">
                        <input
                          id="payment-method"
                          type="radio"
                          name="payment-method"
                          className="radio radio-primary"
                          value="EFECTIVO"
                          checked={paymentMethod === "EFECTIVO"}
                          onChange={() => setPaymentMethod("EFECTIVO")}
                          required
                        />
                        <span>Contado</span>
                      </label>
                      <label className="label cursor-pointer justify-start gap-2">
                        <input
                          id="payment-method-credit"
                          type="radio"
                          name="payment-method"
                          className="radio radio-primary"
                          value="CREDITO"
                          checked={paymentMethod === "CREDITO"}
                          onChange={() => setPaymentMethod("CREDITO")}
                          required
                        />
                        <span>Crédito</span>
                      </label>
                    </div>
                  </Field>
                  <Field id="is-invoiced" label="Facturado" required className="border border-0.5 border-base-300 rounded-lg text-center px-2">
                    <div className="flex flex-wrap gap-x-6 gap-y-2 justify-center">
                      <label className="label cursor-pointer justify-start gap-2">
                        <input
                          id="is-invoiced"
                          type="radio"
                          name="is-invoiced"
                          className="radio radio-primary"
                          value="A"
                          checked={isInvoiced === "A"}
                          onChange={() => setIsInvoiced("A")}
                          required
                        />
                        <span>Sí</span>
                      </label>
                      <label className="label cursor-pointer justify-start gap-2">
                        <input
                          id="not-invoiced"
                          type="radio"
                          name="is-invoiced"
                          className="radio radio-primary"
                          value="P"
                          checked={isInvoiced === "P"}
                          onChange={() => setIsInvoiced("P")}
                          required
                        />
                        <span>No</span>
                      </label>
                    </div>
                  </Field>
                </div>

                {paymentMethod === "CREDITO" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field id="purchase-advance" label="Anticipo">
                      <input
                        id="purchase-advance"
                        className="input w-full border-base-300 bg-base-100"
                        type="number"
                        min="0"
                        step="0.01"
                        value={advance}
                        onChange={(event) => setAdvance(sanitizeDecimal(event.target.value))}
                        placeholder="0.00"
                      />
                    </Field>
                    <Field id="payment-days" label="Frecuencia de pago">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 text-sm">Cada:</span>
                        <input
                          id="payment-days"
                          className="input min-w-0 flex-1 border-base-300 bg-base-100"
                          type="number"
                          min="0"
                          step="1"
                          value={paymentDays}
                          onChange={(event) => setPaymentDays(event.target.value.replace(/\D/g, ""))}
                          placeholder="Días"
                        />
                        <span className="shrink-0 text-sm">días</span>
                      </div>
                    </Field>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field id="received-by" label="Recibió">
                    <input
                      id="received-by"
                      className="input w-full border-base-300 bg-base-100"
                      value={receivedBy}
                      placeholder={userEmail}
                      onChange={(event) => setReceivedBy(sanitizePersonName(event.target.value))}
                    />
                  </Field>
                  <Field id="other-expenses" label="Otros gastos">
                    <input
                      id="other-expenses"
                      className="input w-full border-base-300 bg-base-100"
                      type="number"
                      min="0"
                      step="0.01"
                      value={otherExpenses}
                      onChange={(event) => setOtherExpenses(sanitizeDecimal(event.target.value))}
                      placeholder="0.00"
                    />
                  </Field>
                  <Field id="purchase-notes" label="Notas" className="sm:col-span-2">
                    <textarea
                      id="purchase-notes"
                      className="textarea w-full border-base-300 bg-base-100"
                      rows={3}
                      value={notes}
                      onChange={(event) => setNotes(sanitizeNotes(event.target.value))}
                      placeholder="Notas adicionales de la compra"
                    />
                  </Field>
                </div>
              </div>
            </section>

            <section className="card min-w-0 border border-base-300 bg-base-100 shadow-sm xl:col-span-8">
              <div className="card-body min-w-0 gap-1 p-1 sm:p-5">
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div>
                    <h2 className="card-title">Productos de la compra</h2>
                    <p className="text-sm text-base-content/70">
                      Busca productos; en cantidad, subtotal, descuento e impuestos puedes escribir operaciones como 2 * 3 + 1.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 items-end gap-3 rounded-box border border-base-300 bg-base-200/70 p-3 sm:grid-cols-12">
                  <Field id="product" label="Producto" className="sm:col-span-12">
                    <AutocompleteSelect
                      id="product"
                      value=""
                      options={products.map((product) => ({
                        value: String(product.id),
                        label: product.nombre,
                      }))}
                      placeholder={
                        !branch
                          ? "Selecciona una sucursal primero"
                          : catalogLoading
                            ? "Cargando productos..."
                            : catalog.productError
                              ? "No se pudieron cargar los productos"
                              : products.length === 0
                                ? "Sin productos visibles para esta sucursal"
                                : "Busca o selecciona un producto"
                      }
                      emptyMessage={
                        catalog.productError
                          ? "No se pudieron cargar los productos"
                          : "Sin productos visibles para esta sucursal"
                      }
                      onChange={handleProductSelect}
                      disabled={
                        !branch ||
                        catalogLoading ||
                        Boolean(catalog.productError) ||
                        products.length === 0 ||
                        Boolean(activeCell)
                      }
                      clearOnSelect
                    />
                    {catalogErrorMessage("materias primas", catalog.productError) ? (
                      <p role="alert" className="mt-1 text-xs text-error">
                        {catalogErrorMessage("materias primas", catalog.productError)}
                      </p>
                    ) : null}
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    ["Subtotal", totals.subtotal],
                    ["Descuentos", totals.discount],
                    ["Impuestos", totals.taxes],
                    ["Total", totals.total],
                  ].map(([label, value]) => (
                    <div key={label} className="stat rounded-box border border-base-300 bg-base-200/70 px-4 py-3">
                      <div className="stat-title">{label}</div>
                      <div className={`stat-value text-xl ${label === "Total" ? "text-primary" : ""}`}>
                        {formatMoney(Number(value))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="overflow-x-auto rounded-box border border-base-300">
                  <table className="table table-zebra w-full text-xs!">
                    <thead>
                      <tr>
                        <th className="w-46">Producto</th>
                        <th className="w-20">Marca</th>
                        <th className="text-right w-16">Cant.</th>
                        <th className="w-16">Unidad</th>
                        <th className="text-right w-16">Subtotal</th>
                        <th className="text-right w-16">Desctos.</th>
                        <th className="text-right w-16">Imptos.</th>
                        <th className="text-right w-16">Imp.</th>
                        <th className="" aria-label="Acciones" />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="h-32 text-center text-base-content/60">
                            <span className="inline-flex flex-col items-center gap-2">
                              <PackageOpen className="size-6" aria-hidden="true" />
                              Selecciona productos para agregarlos a la compra.
                            </span>
                          </td>
                        </tr>
                      ) : null}
                      {lines.map((line) => (
                        <tr key={line.key}>
                          <td className="max-w-64 whitespace-normal">{line.productName}</td>
                          <td aria-label="Marca vacía" />
                          {renderLineCell(line, "quantity")}
                          <td>{line.unit}</td>
                          {renderLineCell(line, "subtotal")}
                          {renderLineCell(line, "discount")}
                          {renderLineCell(line, "taxes")}
                          <td className="text-right font-medium">{formatMoney(lineImport(line))}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-circle btn-soft btn-md btn-error"
                              aria-label={`Eliminar ${line.productName}`}
                              title={`Eliminar ${line.productName}`}
                              onClick={() => removeLine(line.key)}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {catalog.cacheWarning ? (
                  <p className="text-xs text-warning">
                    No se pudo guardar o leer el catalogo local; el sistema volvera a consultar Supabase al recargar.
                  </p>
                ) : null}
              </div>
            </section>
          </div>

          <div className="flex flex-col-reverse justify-end gap-3 sm:flex-row">
            <button type="button" className="btn btn-ghost sm:min-w-36" onClick={resetPurchaseFields}>
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary rounded-full sm:min-w-48"
              disabled={!formEnabled || isSubmitting || !supplierId || !paymentMethod || !isInvoiced || lines.length === 0 || Boolean(activeCell)}
            >
              {isSubmitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
              {isSubmitting ? "Enviando compra..." : "Registrar compra"}
            </button>
          </div>
          <p className="text-right text-xs text-base-content/60">
            La compra queda pendiente de procesamiento en la sucursal seleccionada.
          </p>
        </fieldset>
        </form>
      )}
        </>
      )}

      {isSubmitting ? (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-base-100/90 px-4 backdrop-blur-sm"
          role="status"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div className="card w-full max-w-md border border-base-300 bg-base-100 shadow-2xl">
            <div className="card-body items-center gap-4 p-8 text-center">
              <LoaderCircle className="size-12 animate-spin text-primary" aria-hidden="true" />
              <div>
                <h2 className="text-xl font-semibold">Enviando compra a Supabase</h2>
                <p className="mt-2 text-sm text-base-content/70">
                  Se están validando los datos y enviando la compra a la cola de Supabase. El proceso puede tardar si la conexión es lenta.
                </p>
              </div>
              <progress className="progress progress-primary w-full" />
              <p className="text-xs text-base-content/60">Por favor, espera y no recargues la página.</p>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
