import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type {
  PurchaseImportEditedItem,
  PurchaseImportSubmitResult,
  PurchaseImportSubmission,
} from "@/lib/purchases/import-types";

type JsonObject = Record<string, unknown>;
type ExpectedSummary = {
  subtotal: number | null;
  discount: number | null;
  taxes: number | null;
  total: number | null;
};
type SubmitPurchase = PurchaseImportSubmission & { summary: ExpectedSummary };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function isAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const appUrl = process.env.APP_URL;
  if (!appUrl) return false;
  try {
    return new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function finiteNonnegative(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function closeMoney(left: number, right: number | null) {
  return right === null || Math.abs(roundMoney(left) - roundMoney(right)) <= 0.01;
}

function parsePurchase(value: unknown): { purchase: SubmitPurchase | null; error: string | null } {
  if (!isObject(value)) return { purchase: null, error: "El registro de compra no es válido." };
  const jobId = value.jobId;
  const ticketNumber = value.ticketNumber;
  const purchaseDate = value.purchaseDate;
  const supplierId = Number(value.supplierId);
  if (typeof jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return { purchase: null, error: "El identificador de una compra no es válido." };
  }
  if (typeof ticketNumber !== "string" || ticketNumber.length < 3 || ticketNumber.length > 50 || !/^[A-Za-z0-9_#-]+$/.test(ticketNumber)) {
    return { purchase: null, error: "El folio debe tener de 3 a 50 caracteres válidos." };
  }
  if (!validIsoDate(purchaseDate)) return { purchase: null, error: "La fecha de compra no es válida." };
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) return { purchase: null, error: "Selecciona un proveedor válido." };
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 500) {
    return { purchase: null, error: "Cada compra debe incluir entre 1 y 500 productos." };
  }

  const items: PurchaseImportEditedItem[] = [];
  for (const [index, rawItem] of value.items.entries()) {
    if (!isObject(rawItem)) return { purchase: null, error: `El producto ${index + 1} no es válido.` };
    const productId = Number(rawItem.productId);
    const quantity = Number(rawItem.quantity);
    const subtotal = finiteNonnegative(rawItem.subtotal);
    const discount = finiteNonnegative(rawItem.discount);
    const taxes = finiteNonnegative(rawItem.taxes);
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isFinite(quantity) || quantity <= 0 || subtotal === null || discount === null || taxes === null) {
      return { purchase: null, error: `Los datos del producto ${index + 1} no son válidos.` };
    }
    items.push({ productId, quantity, subtotal, discount, taxes });
  }

  if (!isObject(value.summary)) return { purchase: null, error: "No se recibieron los totales de validación." };
  const summaryInput = value.summary;
  const readSummary = (key: keyof ExpectedSummary) => {
    const raw = summaryInput[key];
    return raw === null || raw === undefined ? null : finiteNonnegative(raw);
  };
  const summary = {
    subtotal: readSummary("subtotal"),
    discount: readSummary("discount"),
    taxes: readSummary("taxes"),
    total: readSummary("total"),
  };
  if (Object.entries(summary).some(([key, amount]) => amount === null && summaryInput[key] !== null && summaryInput[key] !== undefined)) {
    return { purchase: null, error: "Los totales de validación no son válidos." };
  }

  return {
    purchase: { jobId, ticketNumber, purchaseDate, supplierId, items, summary },
    error: null,
  };
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return jsonError("Solicitud no permitida.", 403);
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return jsonError("Debes iniciar sesión para enviar compras.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("El lote de compras no contiene JSON válido.", 400);
  }
  if (!isObject(body) || typeof body.schemaName !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(body.schemaName)) {
    return jsonError("Selecciona una sucursal válida.", 400);
  }
  if (!Array.isArray(body.purchases) || body.purchases.length === 0 || body.purchases.length > 10) {
    return jsonError("Cada solicitud debe contener entre 1 y 10 compras.", 400);
  }

  const parsed = body.purchases.map(parsePurchase);
  const invalid = parsed.find((entry) => entry.error);
  if (invalid?.error) return jsonError(invalid.error, 400);
  const purchases = parsed.map((entry) => entry.purchase!);
  const schemaName = body.schemaName;

  const branchResult = await supabase
    .from("empresas_esquemas")
    .select("schema_name")
    .eq("schema_name", schemaName)
    .maybeSingle();
  if (branchResult.error || !branchResult.data) return jsonError("No tienes acceso a la sucursal seleccionada.", 403);

  const supplierIds = [...new Set(purchases.map((purchase) => purchase.supplierId))];
  const productIds = [...new Set(purchases.flatMap((purchase) => purchase.items.map((item) => item.productId)))];
  const branchClient = supabase.schema(schemaName);
  const [suppliersResult, productsResult] = await Promise.all([
    branchClient.from("inv_proveedores").select("id, nombre").eq("estatus", "A").in("id", supplierIds),
    branchClient
      .from("inv_materias_primas")
      .select("id, codigo, codigo_barras, nombre, linea, departamento, unidad, tipo_producto")
      .eq("estatus", "A")
      .in("id", productIds),
  ]);
  if (suppliersResult.error || productsResult.error) {
    console.error("Purchase XLSX catalog validation failed", {
      schemaName,
      supplierCode: suppliersResult.error?.code,
      productCode: productsResult.error?.code,
    });
    return jsonError("No se pudieron validar los proveedores y productos activos de la sucursal.", 403);
  }

  const suppliersById = new Map((suppliersResult.data ?? []).map((supplier) => [Number(supplier.id), supplier]));
  const productsById = new Map((productsResult.data ?? []).map((product) => [Number(product.id), product]));
  const results: PurchaseImportSubmitResult[] = [];

  for (const purchase of purchases) {
    const supplier = suppliersById.get(purchase.supplierId);
    if (!supplier) {
      results.push({ jobId: purchase.jobId, ok: false, error: "El proveedor ya no está activo en esta sucursal." });
      continue;
    }
    if (purchase.items.some((item) => !productsById.has(item.productId))) {
      results.push({ jobId: purchase.jobId, ok: false, error: "Uno o más productos ya no están activos en esta sucursal." });
      continue;
    }

    const itemsPayload = purchase.items.map((item) => {
      const product = productsById.get(item.productId)!;
      const subtotal = roundMoney(item.subtotal);
      const discount = roundMoney(item.discount);
      const taxes = roundMoney(item.taxes);
      return {
        product_id: item.productId,
        product_code: product.codigo,
        product_barcode: product.codigo_barras,
        product_name: product.nombre,
        line: product.linea,
        department: product.departamento,
        brand: "",
        quantity: item.quantity,
        unit: product.unidad,
        product_type: product.tipo_producto,
        subtotal,
        discount,
        taxes,
        amount: roundMoney(subtotal - discount + taxes),
      };
    });
    const subtotal = roundMoney(itemsPayload.reduce((sum, item) => sum + item.subtotal, 0));
    const discount = roundMoney(itemsPayload.reduce((sum, item) => sum + item.discount, 0));
    const taxes = roundMoney(itemsPayload.reduce((sum, item) => sum + item.taxes, 0));
    const total = roundMoney(itemsPayload.reduce((sum, item) => sum + item.amount, 0));

    if (
      !closeMoney(subtotal, purchase.summary.subtotal) ||
      !closeMoney(discount, purchase.summary.discount) ||
      !closeMoney(taxes, purchase.summary.taxes) ||
      !closeMoney(total, purchase.summary.total)
    ) {
      results.push({ jobId: purchase.jobId, ok: false, error: "Los importes ya no coinciden con el resumen revisado." });
      continue;
    }

    const { data: existingJob, error: existingError } = await branchClient
      .from("purchase_import_jobs")
      .select("id, status")
      .eq("id", purchase.jobId)
      .maybeSingle();
    if (existingError) {
      results.push({ jobId: purchase.jobId, ok: false, error: "No se pudo comprobar si esta compra ya fue enviada." });
      continue;
    }
    if (existingJob) {
      if (existingJob.status === "failed") {
        results.push({ jobId: purchase.jobId, ok: false, status: existingJob.status, error: "La solicitud anterior terminó con error; genera una importación nueva para volver a encolarla." });
      } else {
        results.push({ jobId: purchase.jobId, ok: true, status: existingJob.status });
      }
      continue;
    }

    const [year, month, day] = purchase.purchaseDate.split("-");
    const headerPayload = {
      ticket_number: purchase.ticketNumber,
      invoice_number: null,
      purchase_date: purchase.purchaseDate,
      reception_date: purchase.purchaseDate,
      supplier_id: purchase.supplierId,
      supplier_name: supplier.nombre,
      payment_method: "CREDITO",
      invoiced_status: "P",
      advance: 0,
      payment_days: null,
      received_by: authData.user.email ?? "",
      other_expenses: 0,
      notes: `Captura automática de compra del folio: ${purchase.ticketNumber} con fecha: ${day}/${month}/${year}`,
      subtotal,
      discount,
      taxes,
      total,
      document_name: null,
    };
    const { data: jobs, error: enqueueError } = await branchClient.rpc("enqueue_purchase_import_job", {
      p_job_id: purchase.jobId,
      p_header_payload: headerPayload,
      p_items_payload: itemsPayload,
      p_document_path: null,
    });
    const job = jobs?.[0];
    if (enqueueError || !job) {
      console.error("Purchase XLSX enqueue failed", { code: enqueueError?.code, schemaName, jobId: purchase.jobId });
      const error = enqueueError?.code === "42501"
        ? "No tienes permiso para encolar compras en esta sucursal."
        : "No se pudo encolar esta compra.";
      results.push({ jobId: purchase.jobId, ok: false, error });
      continue;
    }
    results.push({ jobId: job.id, ok: job.status !== "failed", status: job.status, ...(job.status === "failed" ? { error: "La compra quedó en estado fallido." } : {}) });
  }

  const ok = results.every((result) => result.ok);
  return NextResponse.json({ ok, results }, { status: ok ? 201 : 207, headers: { "Cache-Control": "no-store" } });
}
