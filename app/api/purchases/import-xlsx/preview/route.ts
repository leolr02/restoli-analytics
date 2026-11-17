import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parsePurchaseWorkbookXlsx } from "@/lib/purchases/xlsx-parser";
import type {
  PurchaseImportDepartment,
  PurchaseImportDraft,
  PurchaseImportEquivalence,
} from "@/lib/purchases/import-types";

const MAX_XLSX_BYTES = 20 * 1024 * 1024;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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

function uuidFromHash(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return jsonError("Solicitud no permitida.", 403);

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return jsonError("Debes iniciar sesión para importar compras.", 401);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("No se pudo leer el archivo enviado.", 400);
  }

  const schemaName = formData.get("schemaName");
  if (typeof schemaName !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    return jsonError("Selecciona una sucursal válida.", 400);
  }
  const fileValue = formData.get("file");
  if (typeof File === "undefined" || !(fileValue instanceof File) || fileValue.size === 0) {
    return jsonError("Selecciona un archivo XLSX válido.", 400);
  }
  if (!fileValue.name.toLowerCase().endsWith(".xlsx")) {
    return jsonError("El archivo debe tener extensión .xlsx.", 400);
  }
  if (fileValue.type && fileValue.type !== XLSX_MIME && fileValue.type !== "application/octet-stream") {
    return jsonError("El tipo del archivo no corresponde a un libro XLSX.", 400);
  }
  if (fileValue.size > MAX_XLSX_BYTES) {
    return jsonError("El archivo XLSX no puede exceder 20 MiB.", 413);
  }

  const branchResult = await supabase
    .from("empresas_esquemas")
    .select("schema_name")
    .eq("schema_name", schemaName)
    .maybeSingle();
  if (branchResult.error || !branchResult.data) return jsonError("No tienes acceso a la sucursal seleccionada.", 403);

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await fileValue.arrayBuffer());
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
      return jsonError("El contenido del archivo no es un libro XLSX válido.", 400);
    }
  } catch {
    return jsonError("No se pudo leer el contenido del archivo XLSX.", 400);
  }

  let parsed: ReturnType<typeof parsePurchaseWorkbookXlsx>;
  try {
    parsed = parsePurchaseWorkbookXlsx(bytes);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "No se pudo interpretar el libro XLSX.", 400);
  }

  const branchClient = supabase.schema(schemaName);
  const [equivalenceResult, departmentResult] = await Promise.all([
    branchClient
      .from("inv_equivalencias")
      .select("materiaprima, nombre, equivalencia")
      .order("materiaprima"),
    branchClient
      .from("inv_departamentos_materias_primas")
      .select("id, nombre")
      .eq("estatus", "A"),
  ]);

  if (equivalenceResult.error) {
    console.error("Purchase XLSX equivalence query failed", { code: equivalenceResult.error.code, schemaName });
    return jsonError(
      equivalenceResult.error.code === "42501"
        ? "No se pudieron leer las equivalencias. Aplica la migración de acceso XLSX para inv_equivalencias."
        : "No se pudo consultar inv_equivalencias en la sucursal.",
      equivalenceResult.error.code === "42501" ? 403 : 502,
    );
  }
  if (departmentResult.error) {
    console.error("Purchase XLSX department query failed", { code: departmentResult.error.code, schemaName });
    return jsonError("No se pudieron consultar los departamentos de la sucursal.", 502);
  }

  const batchId = createHash("sha256").update(schemaName).update("\0").update(bytes).digest("hex");
  const purchases: PurchaseImportDraft[] = parsed.map((purchase, index) => {
    const identity = [
      purchase.supplierName.trim().toLocaleUpperCase("es-MX"),
      purchase.purchaseDate,
      purchase.ticketNumber.trim(),
      purchase.sourceSheet,
      ...purchase.sourceRows,
      index,
    ].join("|");
    return {
      ...purchase,
      jobId: uuidFromHash(`${batchId}|${identity}`),
    };
  });

  const equivalences = (equivalenceResult.data ?? [])
    .map((row) => ({
      materiaprima: Number(row.materiaprima),
      nombre: String(row.nombre ?? ""),
      equivalencia: Number(row.equivalencia),
    }))
    .filter((row): row is PurchaseImportEquivalence =>
      Number.isSafeInteger(row.materiaprima) && row.materiaprima > 0 &&
      row.nombre.length > 0 && Number.isFinite(row.equivalencia) && row.equivalencia > 0,
    );
  const departments = (departmentResult.data ?? [])
    .map((row) => ({ id: Number(row.id), nombre: String(row.nombre ?? "") }))
    .filter((row): row is PurchaseImportDepartment => Number.isSafeInteger(row.id) && row.id > 0 && row.nombre.length > 0);

  return NextResponse.json({
    batchId,
    fileName: fileValue.name,
    purchases,
    equivalences,
    departments,
  }, { headers: { "Cache-Control": "no-store" } });
}
