export default function ProtectedLoading() {
  return (
    <main
      className="grid min-h-svh place-items-center bg-base-200 text-base-content"
      aria-label="Cargando compras"
    >
      <div className="flex items-center gap-3" role="status">
        <span className="loading loading-spinner loading-md text-primary" aria-hidden="true" />
        <span>Cargando compras…</span>
      </div>
    </main>
  );
}
