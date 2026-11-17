"use client";

import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type PurchaseHistoryItem = {
  schema_name: string;
  id: string;
  status: "pending" | "processing" | "local_processed" | "replicated" | "failed";
  created_at: string;
  processed_at: string | null;
  replicated_at: string | null;
  local_purchase_id: number | null;
  last_error: string | null;
  supplier_name?: string | null;
  header_payload: {
    purchase_date?: string | null;
    ticket_number?: string | null;
    invoice_number?: string | null;
    supplier_id?: number | string | null;
    supplier_name?: string | null;
    total?: number | string | null;
  };
};

type HistoryResponse = {
  totalCount: number;
  page: number;
  pageSize: number;
  items: PurchaseHistoryItem[];
};

const PAGE_SIZE = 100;

const STATUS_LABELS: Record<PurchaseHistoryItem["status"], string> = {
  pending: "Pendiente de recepción",
  processing: "Procesando en sucursal",
  local_processed: "Procesada localmente",
  replicated: "Sincronizada",
  failed: "Error de procesamiento",
};

const STATUS_CLASSES: Record<PurchaseHistoryItem["status"], string> = {
  pending: "badge-warning",
  processing: "badge-info",
  local_processed: "badge-accent",
  replicated: "badge-success",
  failed: "badge-error",
};

function branchLabel(schemaName: string) {
  const label = schemaName.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatMoney(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "—";
  return amount.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function formatPurchaseDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-MX", { dateStyle: "medium" }).format(date);
}

function visiblePages(page: number, totalPages: number) {
  const first = Math.max(1, Math.min(page - 2, totalPages - 4));
  const last = Math.min(totalPages, first + 4);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
}

function compareHistoryItems(left: PurchaseHistoryItem, right: PurchaseHistoryItem) {
  const createdAtDifference = new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  if (createdAtDifference !== 0) return createdAtDifference;
  const branchDifference = left.schema_name.localeCompare(right.schema_name);
  return branchDifference || right.id.localeCompare(left.id);
}

function searchableItemText(item: PurchaseHistoryItem) {
  return [
    JSON.stringify(item),
    branchLabel(item.schema_name),
    STATUS_LABELS[item.status],
    formatPurchaseDate(item.header_payload?.purchase_date),
    formatMoney(item.header_payload?.total),
  ].join(" ").toLocaleLowerCase("es-MX");
}

function errorMessage(payload: unknown) {
  if (
    typeof payload === "object" && payload !== null &&
    "error" in payload && typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return "No se pudo cargar el historial de compras.";
}

export function PurchaseHistory() {
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchSource, setSearchSource] = useState<"history" | "local" | "supabase">("history");
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const previousSearchRef = useRef("");
  const loadedPagesRef = useRef(new Map<string, HistoryResponse>());

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(searchTerm.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [searchTerm]);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  useEffect(() => {
    if (previousSearchRef.current !== debouncedSearch) {
      previousSearchRef.current = debouncedSearch;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }

    const controller = new AbortController();
    setError(null);

    if (debouncedSearch) {
      const cachedItems = [...loadedPagesRef.current.values()].flatMap((cachedPage) => cachedPage.items);
      const uniqueCachedItems = Array.from(
        new Map(cachedItems.map((item) => [`${item.schema_name}:${item.id}`, item])).values(),
      );
      const normalizedSearch = debouncedSearch.toLocaleLowerCase("es-MX");
      const localMatches = uniqueCachedItems
        .filter((item) => searchableItemText(item).includes(normalizedSearch))
        .sort(compareHistoryItems);

      if (localMatches.length > 0) {
        setSearchSource("local");
        setHistory({
          totalCount: localMatches.length,
          page,
          pageSize: PAGE_SIZE,
          items: localMatches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        });
        setLoading(false);
        return () => controller.abort();
      }
    }

    setSearchSource(debouncedSearch ? "supabase" : "history");
    setLoading(true);
    const searchQuery = debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : "";

    void fetch(`/api/purchases?page=${page}${searchQuery}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorMessage(payload));
        return payload as HistoryResponse;
      })
      .then((result) => {
        if (
          !result || !Number.isSafeInteger(result.totalCount) ||
          !Array.isArray(result.items) || !Number.isSafeInteger(result.pageSize)
        ) {
          throw new Error("La respuesta del historial no tiene un formato válido.");
        }
        setHistory(result);
        loadedPagesRef.current.set(`${debouncedSearch}:${page}`, result);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "No se pudo cargar el historial de compras.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [page, debouncedSearch, refreshKey]);

  const totalCount = history?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const pages = useMemo(() => visiblePages(page, totalPages), [page, totalPages]);
  const isSearchPending = searchTerm.trim() !== debouncedSearch;
  const countSummary = isSearchPending
    ? "Preparando búsqueda…"
    : debouncedSearch
      ? searchSource === "local"
        ? `${totalCount.toLocaleString("es-MX")} coincidencias locales`
        : `${totalCount.toLocaleString("es-MX")} resultados en Supabase`
      : `${totalCount.toLocaleString("es-MX")} registros · ${PAGE_SIZE} por página`;

  useEffect(() => {
    const lastPage = Math.max(1, totalPages);
    if (!loading && page > lastPage) setPage(lastPage);
  }, [loading, page, totalPages]);

  return (
    <section aria-label="Historial de compras" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-primary/70">Historial de compras</h1>
          <p className="mt-1 text-sm text-base-content/70">
            Registros ordenados del más reciente al más antiguo
          </p>
          <label className="input mt-3 flex w-full max-w-2xl items-center gap-2">
            <svg
              className="h-[1em] opacity-50"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <g
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeWidth="2.5"
                fill="none"
                stroke="currentColor"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </g>
            </svg>
            <input
              ref={searchInputRef}
              type="search"
              className="grow"
              value={searchTerm}
              placeholder="Buscar por sucursal, proveedor, ticket, factura o producto"
              aria-label="Buscar en el historial de compras"
              onChange={(event) => {
                setSearchTerm(event.target.value);
                setLoading(true);
              }}
            />
            <kbd className="kbd kbd-sm">Alt</kbd>
            <kbd className="kbd kbd-sm">B</kbd>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-base-content/70" aria-live="polite">
            {countSummary}
          </p>
          <button
            type="button"
            className="btn btn-square btn-ghost btn-sm"
            aria-label="Actualizar historial"
            title="Actualizar historial"
            disabled={loading}
            onClick={() => {
              loadedPagesRef.current.clear();
              setRefreshKey((current) => current + 1);
            }}
          >
            {loading
              ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              : <RefreshCw className="size-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="alert alert-error">
          <span>{error}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              loadedPagesRef.current.clear();
              setRefreshKey((current) => current + 1);
            }}
          >
            Reintentar
          </button>
        </div>
      ) : null}

      <div className="relative overflow-x-auto rounded-box border border-base-300 bg-base-100">
        <table className="table table-zebra w-full">
          <thead>
            <tr>
              <th>Sucursal</th>
              <th>Fecha</th>
              <th>No. Ticket</th>
              <th>No. Factura</th>
              <th>Proveedor</th>
              <th className="text-right">Total</th>
              <th>Estado</th>
              <th>Enviada</th>
            </tr>
          </thead>
          <tbody>
            {loading && !history ? (
              <tr>
                <td colSpan={8} className="h-40 text-center">
                  <span className="inline-flex items-center gap-2 text-base-content/70">
                    <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
                    Consultando datos remotos…
                  </span>
                </td>
              </tr>
            ) : null}
            {!loading && !error && history?.items.length === 0 ? (
              <tr>
                <td colSpan={8} className="h-40 text-center text-base-content/60">
                  {debouncedSearch
                    ? "No se encontraron coincidencias en Supabase."
                    : "No hay compras registradas en las sucursales disponibles."}
                </td>
              </tr>
            ) : null}
            {history?.items.map((item) => (
              <tr key={`${item.schema_name}:${item.id}`}>
                <td>
                  <span className="badge badge-xs badge-success rounded-full">
                    {branchLabel(item.schema_name)}
                  </span>
                </td>
                <td>{formatPurchaseDate(item.header_payload?.purchase_date)}</td>
                <td>{item.header_payload?.ticket_number || "—"}</td>
                <td>{item.header_payload?.invoice_number || "—"}</td>
                <td>
                  {item.supplier_name || item.header_payload?.supplier_name ||
                    (item.header_payload?.supplier_id ? "Proveedor no disponible" : "—")}
                </td>
                <td className="text-right font-medium">{formatMoney(item.header_payload?.total)}</td>
                <td>
                  <div className="flex flex-col items-start gap-1">
                    <span className={`badge badge-dash rounded-full badge-xs ${STATUS_CLASSES[item.status] ?? "badge-ghost"}`}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                    {item.status === "failed" && item.last_error ? (
                      <span className="max-w-64 truncate text-xs text-error" title={item.last_error}>
                        {item.last_error}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>{new Intl.DateTimeFormat("es-MX", { dateStyle: "short", timeStyle: "short" }).format(new Date(item.created_at))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && history ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-base-100/80 backdrop-blur-[1px]" role="status" aria-live="polite">
            <span className="inline-flex items-center gap-2 rounded-box bg-base-100 px-4 py-3 shadow">
              <LoaderCircle className="size-5 animate-spin text-primary" aria-hidden="true" />
              Cargando página {page}…
            </span>
          </div>
        ) : null}
      </div>

      {totalPages > 0 ? (
        <nav className="flex flex-wrap items-center justify-center gap-2" aria-label="Paginación del historial">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={page <= 1 || loading}
            aria-label="Página anterior"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            Anterior
          </button>
          {pages.map((pageNumber) => (
            <button
              key={pageNumber}
              type="button"
              className={`btn btn-sm ${pageNumber === page ? "btn-primary" : "btn-ghost"}`}
              aria-current={pageNumber === page ? "page" : undefined}
              disabled={loading}
              onClick={() => setPage(pageNumber)}
            >
              {pageNumber}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={page >= totalPages || loading}
            aria-label="Página siguiente"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            Siguiente
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
          <span className="w-full text-center text-xs text-base-content/60 sm:w-auto">
            Página {page} de {totalPages}
          </span>
        </nav>
      ) : null}
    </section>
  );
}
