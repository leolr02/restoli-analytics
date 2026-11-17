import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <main className="grid min-h-svh place-items-center bg-base-200 p-4 text-base-content">
      <section className="card w-full max-w-lg border border-base-300 bg-base-100 shadow-xl">
        <div className="card-body items-center gap-4 text-center">
          <h1 className="card-title text-2xl">El enlace no es válido o ya venció</h1>
          <p className="text-sm text-base-content/70">
            Solicita a root que envíe una invitación nueva y abre el enlace desde el correo recibido.
          </p>
          <Link href="/" className="btn btn-primary mt-2">
            Volver al inicio
          </Link>
        </div>
      </section>
    </main>
  );
}
