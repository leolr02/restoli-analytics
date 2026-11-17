const DATABASE_NAME = "restoli-purchase-catalogs";
const DATABASE_VERSION = 1;
const CATALOG_STORE = "catalogs";

export type PurchaseCatalogKind = "products" | "suppliers";

type CachedCatalog<T> = {
  key: string;
  items: T[];
  savedAt: number;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB no está disponible en este navegador."));
  }

  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CATALOG_STORE)) {
          database.createObjectStore(CATALOG_STORE, { keyPath: "key" });
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("No se pudo abrir IndexedDB."));
      request.onblocked = () => reject(new Error("IndexedDB está bloqueada por otra pestaña."));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }

  return databasePromise;
}

export function purchaseCatalogCacheKey(
  userId: string,
  schemaName: string,
  kind: PurchaseCatalogKind,
) {
  return JSON.stringify([userId, schemaName, kind]);
}

export async function readPurchaseCatalog<T>(key: string): Promise<T[] | null> {
  const database = await openDatabase();

  return new Promise<T[] | null>((resolve, reject) => {
    const transaction = database.transaction(CATALOG_STORE, "readonly");
    const request = transaction.objectStore(CATALOG_STORE).get(key) as IDBRequest<
      CachedCatalog<T> | undefined
    >;

    request.onsuccess = () => {
      const record = request.result;
      resolve(record && Array.isArray(record.items) ? record.items : null);
    };
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer el catálogo local."));
  });
}

export async function writePurchaseCatalog<T>(key: string, items: T[]) {
  const database = await openDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CATALOG_STORE, "readwrite");
    transaction.objectStore(CATALOG_STORE).put({
      key,
      items,
      savedAt: Date.now(),
    } satisfies CachedCatalog<T>);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el catálogo local."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Se canceló el guardado local."));
  });
}
