import { createClient } from "@/lib/supabase/client";
import {
  purchaseCatalogCacheKey,
  readPurchaseCatalog,
  writePurchaseCatalog,
} from "@/lib/indexeddb/purchase-catalog-cache";

export type PurchaseProduct = {
  id: number;
  codigo: string | null;
  codigo_barras: string | null;
  nombre: string;
  linea: number;
  departamento: number;
  unidad: string;
  tipo_producto: number | null;
};

export type PurchaseSupplier = {
  id: number;
  nombre: string | null;
  limitecredito: number | null;
  saldo: number | null;
};

export type CatalogQueryError = {
  code: string;
  message: string;
};

export type PurchaseCatalogs = {
  products: PurchaseProduct[];
  suppliers: PurchaseSupplier[];
  productError: CatalogQueryError | null;
  supplierError: CatalogQueryError | null;
  cacheWarning: boolean;
};

const inFlightLoads = new Map<string, Promise<PurchaseCatalogs>>();
const memoryCache = new Map<string, PurchaseCatalogs>();

function requestError(error: { code?: string; message?: string } | null) {
  if (!error) return null;
  return {
    code: error.code || "UNKNOWN",
    message: error.message || "Error desconocido al consultar el catálogo.",
  };
}

async function loadCatalogs(userId: string, schemaName: string): Promise<PurchaseCatalogs> {
  const cacheKey = JSON.stringify([userId, schemaName]);
  const inMemoryCatalogs = memoryCache.get(cacheKey);
  if (inMemoryCatalogs) return inMemoryCatalogs;

  const productsKey = purchaseCatalogCacheKey(userId, schemaName, "products");
  const suppliersKey = purchaseCatalogCacheKey(userId, schemaName, "suppliers");
  const [productCacheRead, supplierCacheRead] = await Promise.allSettled([
    readPurchaseCatalog<PurchaseProduct>(productsKey),
    readPurchaseCatalog<PurchaseSupplier>(suppliersKey),
  ]);

  let cacheWarning =
    productCacheRead.status === "rejected" || supplierCacheRead.status === "rejected";
  const cachedProducts =
    productCacheRead.status === "fulfilled" ? productCacheRead.value : null;
  const cachedSuppliers =
    supplierCacheRead.status === "fulfilled" ? supplierCacheRead.value : null;

  const supabase = createClient();
  const [productResult, supplierResult] = await Promise.all([
    cachedProducts !== null
      ? Promise.resolve({ data: cachedProducts, error: null })
      : supabase
          .schema(schemaName)
          .from("inv_materias_primas")
          .select("id, codigo, codigo_barras, nombre, linea, departamento, unidad, tipo_producto")
          .eq("estatus", "A")
          .order("nombre"),
    cachedSuppliers !== null
      ? Promise.resolve({ data: cachedSuppliers, error: null })
      : supabase
          .schema(schemaName)
          .from("inv_proveedores")
          .select("id, nombre, limitecredito, saldo")
          .eq("estatus", "A")
          .order("nombre"),
  ]);

  const products = (productResult.data ?? []) as PurchaseProduct[];
  const suppliers = (supplierResult.data ?? []) as PurchaseSupplier[];
  const productError = requestError(productResult.error);
  const supplierError = requestError(supplierResult.error);

  if (!productError && cachedProducts === null) {
    try {
      await writePurchaseCatalog(productsKey, products);
    } catch {
      cacheWarning = true;
    }
  }
  if (!supplierError && cachedSuppliers === null) {
    try {
      await writePurchaseCatalog(suppliersKey, suppliers);
    } catch {
      cacheWarning = true;
    }
  }

  const result = {
    products,
    suppliers,
    productError,
    supplierError,
    cacheWarning,
  };

  if (!productError && !supplierError) {
    memoryCache.set(cacheKey, result);
  }

  return result;
}

export function loadPurchaseCatalogs(userId: string, schemaName: string) {
  const key = JSON.stringify([userId, schemaName]);
  const activeLoad = inFlightLoads.get(key);
  if (activeLoad) return activeLoad;

  const request = loadCatalogs(userId, schemaName).finally(() => {
    inFlightLoads.delete(key);
  });
  inFlightLoads.set(key, request);
  return request;
}
