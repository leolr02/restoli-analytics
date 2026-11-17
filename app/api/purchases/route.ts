import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DOCUMENT_BUCKET = "purchase-documents";
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_LINES = 500;

const DOCUMENT_MIME_TYPES: Record<string, { mime: string; accepted: string[] }> = {
  png: { mime: "image/png", accepted: ["image/png"] },
  jpg: { mime: "image/jpeg", accepted: ["image/jpeg"] },
  jpeg: { mime: "image/jpeg", accepted: ["image/jpeg"] },
  pdf: { mime: "application/pdf", accepted: ["application/pdf"] },
  xml: {
    mime: "application/xml",
    accepted: ["application/xml", "text/xml", "application/octet-stream"],
  },
};

type JsonObject = Record<string, unknown>;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const pageValue = searchParams.get("page") ?? "1";
  const page = Number(pageValue);
  const search = (searchParams.get("search") ?? "").trim();
  if (!/^[1-9]\d{0,6}$/.test(pageValue) || page > 1_000_000) {
    return jsonError("El número de página no es válido.", 400);
  }
  if (search.length > 200) {
    return jsonError("El término de búsqueda no puede exceder 200 caracteres.", 400);
  }

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    return jsonError("Debes iniciar sesión para consultar el historial.", 401);
  }

  const { data, error } = await supabase.rpc("get_purchase_import_history", {
    p_page: page,
    p_search: search || null,
  });
  if (error) {
    console.error("Purchase history query failed", { code: error.code });
    if (error.code === "42501") {
      return jsonError("No tienes permiso para consultar este historial.", 403);
    }
    if (error.code === "PGRST202" || error.code === "42883") {
      return jsonError(
        "Supabase no encuentra la función de búsqueda del historial. Aplica la migración 20261115130000_purchase_history_search.sql; si ya la aplicaste, actualiza la caché del esquema de la API.",
        503,
      );
    }
    if (error.code === "PGRST106") {
      return jsonError("El esquema public debe estar expuesto en la configuración de la API de Supabase.", 503);
    }
    return jsonError("No se pudo cargar el historial de compras.", 502);
  }

  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonField(formData: FormData, fieldName: string): unknown {
  const value = formData.get(fieldName);
  if (typeof value !== "string") throw new Error(`Falta el campo ${fieldName}.`);

  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`El campo ${fieldName} no contiene JSON válido.`);
  }
}

function optionalReference(value: unknown, fieldName: string, maxLength: number) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${fieldName} no es válido.`);

  const reference = value.trim();
  if (reference.length < 3 || reference.length > maxLength || !/^[A-Za-z0-9_#-]+$/.test(reference)) {
    throw new Error(`${fieldName} debe tener de 3 a ${maxLength} caracteres válidos.`);
  }
  return reference;
}

function nonnegativeNumber(value: unknown, fieldName: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} debe ser un número mayor o igual que cero.`);
  }
  return parsed;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

function documentMime(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const definition = DOCUMENT_MIME_TYPES[extension];
  if (!definition) return null;
  if (file.type && !definition.accepted.includes(file.type.toLowerCase())) return null;
  return { extension, mime: definition.mime };
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return jsonError("Solicitud no permitida.", 403);

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    return jsonError("Debes iniciar sesión para registrar una compra.", 401);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("El formulario enviado no es válido.", 400);
  }

  const schemaNameValue = formData.get("schemaName");
  if (
    typeof schemaNameValue !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(schemaNameValue)
  ) {
    return jsonError("Selecciona una sucursal válida.", 400);
  }
  const schemaName = schemaNameValue;
  const jobIdValue = formData.get("jobId");
  if (
    typeof jobIdValue !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobIdValue)
  ) {
    return jsonError("El identificador de la solicitud no es válido.", 400);
  }
  const jobId = jobIdValue;

  let headerInput: unknown;
  let itemsInput: unknown;
  try {
    headerInput = parseJsonField(formData, "headerPayload");
    itemsInput = parseJsonField(formData, "itemsPayload");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "El contenido de la compra no es válido.", 400);
  }
  if (!isObject(headerInput) || !Array.isArray(itemsInput) || itemsInput.length < 1 || itemsInput.length > MAX_LINES) {
    return jsonError("La compra debe incluir un encabezado y al menos un producto.", 400);
  }

  let ticketNumber: string | null;
  let invoiceNumber: string | null;
  try {
    ticketNumber = optionalReference(headerInput.ticket_number, "No. Ticket", 50);
    invoiceNumber = optionalReference(headerInput.invoice_number, "No. Factura", 80);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Las referencias de compra no son válidas.", 400);
  }
  if (!validIsoDate(headerInput.purchase_date)) {
    return jsonError("La fecha de compra debe tener el formato yyyy-mm-dd.", 400);
  }
  const supplierId = Number(headerInput.supplier_id);
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    return jsonError("Selecciona un proveedor válido.", 400);
  }
  if (headerInput.payment_method !== "EFECTIVO" && headerInput.payment_method !== "CREDITO") {
    return jsonError("Selecciona contado o crédito.", 400);
  }
  if (headerInput.invoiced_status !== "A" && headerInput.invoiced_status !== "P") {
    return jsonError("Indica si la compra fue facturada.", 400);
  }

  let advance: number;
  let otherExpenses: number;
  let paymentDays: number | null;
  try {
    advance = nonnegativeNumber(headerInput.advance ?? 0, "Anticipo");
    otherExpenses = nonnegativeNumber(headerInput.other_expenses ?? 0, "Otros gastos");
    if (headerInput.payment_days === null || headerInput.payment_days === "") {
      paymentDays = null;
    } else {
      const parsedDays = Number(headerInput.payment_days);
      if (!Number.isSafeInteger(parsedDays) || parsedDays < 0) {
        throw new Error("La frecuencia de pago debe ser un entero mayor o igual que cero.");
      }
      paymentDays = parsedDays;
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Los importes de la compra no son válidos.", 400);
  }

  const receivedBy = typeof headerInput.received_by === "string" && headerInput.received_by.trim()
    ? headerInput.received_by.trim()
    : authData.user.email ?? "";
  const allowedReceivedBy = /^[\p{L}\p{N}@# ]+$/u.test(receivedBy) ||
    (receivedBy === authData.user.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receivedBy));
  if (!allowedReceivedBy || receivedBy.length > 180) {
    return jsonError("El campo Recibió contiene caracteres no permitidos.", 400);
  }

  const notes = typeof headerInput.notes === "string" ? headerInput.notes : "";
  if (notes.length > 4000 || !/^[\p{L}\p{N},#@* \r\n]*$/u.test(notes)) {
    return jsonError("Notas contiene caracteres no permitidos o excede el límite.", 400);
  }

  const rawLines: Array<{
    productId: number;
    quantity: number;
    subtotal: number;
    discount: number;
    taxes: number;
  }> = [];
  try {
    for (const [index, rawLine] of itemsInput.entries()) {
      if (!isObject(rawLine)) throw new Error(`El producto ${index + 1} no es válido.`);
      const productId = Number(rawLine.product_id);
      const quantity = Number(rawLine.quantity);
      if (!Number.isSafeInteger(productId) || productId <= 0) {
        throw new Error(`El producto ${index + 1} no tiene un identificador válido.`);
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`La cantidad del producto ${index + 1} debe ser mayor que cero.`);
      }
      rawLines.push({
        productId,
        quantity,
        subtotal: nonnegativeNumber(rawLine.subtotal, `Subtotal del producto ${index + 1}`),
        discount: nonnegativeNumber(rawLine.discount, `Descuento del producto ${index + 1}`),
        taxes: nonnegativeNumber(rawLine.taxes, `Impuestos del producto ${index + 1}`),
      });
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Los productos de la compra no son válidos.", 400);
  }

  const branchResult = await supabase
    .from("empresas_esquemas")
    .select("schema_name")
    .eq("schema_name", schemaName)
    .maybeSingle();
  if (branchResult.error || !branchResult.data) {
    return jsonError("No tienes acceso a la sucursal seleccionada.", 403);
  }

  const branchClient = supabase.schema(schemaName);
  const { data: existingJob, error: existingJobError } = await branchClient
    .from("purchase_import_jobs")
    .select("id, status")
    .eq("id", jobId)
    .maybeSingle();
  if (existingJobError) {
    return jsonError("No se pudo comprobar si la solicitud ya fue enviada.", 403);
  }
  if (existingJob) {
    if (existingJob.status === "failed") {
      return jsonError("La solicitud anterior terminó con error. Cancela y registra una solicitud nueva.", 409);
    }
    return NextResponse.json({ ok: true, id: existingJob.id, status: existingJob.status });
  }

  const [supplierResult, productsResult] = await Promise.all([
    branchClient
      .from("inv_proveedores")
      .select("id, nombre")
      .eq("id", supplierId)
      .eq("estatus", "A")
      .maybeSingle(),
    branchClient
      .from("inv_materias_primas")
      .select("id, codigo, codigo_barras, nombre, linea, departamento, unidad, tipo_producto")
      .eq("estatus", "A")
      .in("id", [...new Set(rawLines.map((line) => line.productId))]),
  ]);

  if (supplierResult.error || !supplierResult.data) {
    return jsonError("El proveedor no está activo o no pertenece a esta sucursal.", 400);
  }
  if (productsResult.error) {
    return jsonError("No se pudieron validar los productos contra el catálogo de la sucursal.", 403);
  }

  const productsById = new Map(
    (productsResult.data ?? []).map((product) => [Number(product.id), product]),
  );
  if (rawLines.some((line) => !productsById.has(line.productId))) {
    return jsonError("Uno o más productos ya no están activos en esta sucursal.", 400);
  }

  const itemsPayload = rawLines.map((line) => {
    const product = productsById.get(line.productId)!;
    const subtotal = roundMoney(line.subtotal);
    const discount = roundMoney(line.discount);
    const taxes = roundMoney(line.taxes);
    return {
      product_id: line.productId,
      product_code: product.codigo,
      product_barcode: product.codigo_barras,
      product_name: product.nombre,
      line: product.linea,
      department: product.departamento,
      brand: "",
      quantity: line.quantity,
      unit: product.unidad,
      product_type: product.tipo_producto,
      subtotal,
      discount,
      taxes,
      amount: roundMoney(subtotal - discount + taxes),
    };
  });

  const subtotal = roundMoney(itemsPayload.reduce((sum, line) => sum + line.subtotal, 0));
  const discount = roundMoney(itemsPayload.reduce((sum, line) => sum + line.discount, 0));
  const taxes = roundMoney(itemsPayload.reduce((sum, line) => sum + line.taxes, 0));
  const total = roundMoney(itemsPayload.reduce((sum, line) => sum + line.amount, 0) + otherExpenses);
  if (headerInput.payment_method === "CREDITO" && advance >= total) {
    return jsonError("El anticipo debe ser menor que el total de la compra.", 400);
  }

  const attachmentValue = formData.get("attachment");
  let attachment: File | null = null;
  let attachmentType: { extension: string; mime: string } | null = null;
  if (attachmentValue !== null) {
    if (typeof File === "undefined" || !(attachmentValue instanceof File) || attachmentValue.size === 0) {
      return jsonError("El documento adjunto no es válido.", 400);
    }
    if (attachmentValue.size > MAX_DOCUMENT_BYTES) {
      return jsonError("El documento no puede exceder 50 MiB.", 400);
    }
    attachmentType = documentMime(attachmentValue);
    if (!attachmentType) {
      return jsonError("El documento debe ser PNG, JPG, JPEG, PDF o XML.", 400);
    }
    attachment = attachmentValue;
  }

  let documentPath: string | null = null;
  if (attachment && attachmentType) {
    documentPath = `${schemaName}/${authData.user.id}/${jobId}.${attachmentType.extension}`;
    const { error: uploadError } = await supabase.storage
      .from(DOCUMENT_BUCKET)
      .upload(documentPath, attachment, {
        contentType: attachmentType.mime,
        upsert: false,
      });

    if (uploadError) {
      console.error("Purchase document upload failed", { code: uploadError.name });
      return jsonError("No se pudo guardar el documento de la compra.", 502);
    }
  }

  const headerPayload = {
    ticket_number: ticketNumber,
    invoice_number: invoiceNumber,
    purchase_date: headerInput.purchase_date,
    reception_date: headerInput.purchase_date,
    supplier_id: supplierId,
    supplier_name: supplierResult.data.nombre,
    payment_method: headerInput.payment_method,
    invoiced_status: headerInput.invoiced_status,
    advance: headerInput.payment_method === "CREDITO" ? advance : 0,
    payment_days: headerInput.payment_method === "CREDITO" ? paymentDays : null,
    received_by: receivedBy,
    other_expenses: otherExpenses,
    notes: notes || null,
    subtotal,
    discount,
    taxes,
    total,
    document_name: attachment?.name.split(/[\\/]/).pop() ?? null,
  };

  const { data: jobs, error: insertError } = await branchClient.rpc(
    "enqueue_purchase_import_job",
    {
      p_job_id: jobId,
      p_header_payload: headerPayload,
      p_items_payload: itemsPayload,
      p_document_path: documentPath,
    },
  );
  const job = jobs?.[0];

  if (insertError || !job) {
    const { data: committedJob, error: confirmationError } = await branchClient
      .from("purchase_import_jobs")
      .select("id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (committedJob) {
      if (committedJob.status === "failed") {
        return jsonError("La solicitud anterior terminó con error. Cancela y registra una solicitud nueva.", 409);
      }
      return NextResponse.json({
        ok: true,
        id: committedJob.id,
        status: committedJob.status,
      });
    }

    if (documentPath && !confirmationError) {
      const { error: cleanupError } = await supabase.storage
        .from(DOCUMENT_BUCKET)
        .remove([documentPath]);
      if (cleanupError) {
        console.error("Purchase document cleanup failed", { code: cleanupError.name });
      }
    }
    if (confirmationError) {
      console.error("Purchase import confirmation check failed", {
        code: confirmationError.code,
        schemaName,
      });
    }
    console.error("Purchase import enqueue failed", {
      code: insertError?.code,
      schemaName,
    });
    if (insertError?.code === "22023" || insertError?.code === "23514" || insertError?.code === "22P02") {
      return jsonError("Los datos de la compra no pasaron la validación de Supabase.", 400);
    }
    if (insertError?.code === "23505") {
      return jsonError("El identificador de esta solicitud ya está asociado a otro registro.", 409);
    }
    if (insertError?.code === "42501") {
      return jsonError("No tienes permiso para registrar compras en esta sucursal.", 403);
    }
    return jsonError("No se pudo enviar la compra a la sucursal. Inténtalo de nuevo.", 502);
  }

  if (job.status === "failed") {
    return jsonError("La solicitud anterior terminó con error. Cancela y registra una solicitud nueva.", 409);
  }

  return NextResponse.json({ ok: true, id: job.id, status: job.status }, { status: 201 });
}
