"use client";

import { LogOut, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

export function AccessPending({
  description = "Tu usuario todavía no tiene un perfil y una sucursal asignados. Contacta a root para habilitar el acceso.",
}: {
  description?: string;
}) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const router = useRouter();

  const signOut = async () => {
    setIsSigningOut(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signOut();

    if (error) {
      notify.error("No se pudo cerrar la sesión.");
      setIsSigningOut(false);
      return;
    }

    router.replace("/");
    router.refresh();
  };

  return (
    <main className="grid min-h-svh place-items-center bg-base-200 p-4 text-base-content">
      <section className="card w-full max-w-lg border border-base-300 bg-base-100 shadow-xl">
        <div className="card-body items-center gap-4 text-center">
          <div className="rounded-full bg-warning/10 p-4 text-warning">
            <ShieldAlert className="size-8" aria-hidden="true" />
          </div>
          <h1 className="card-title text-2xl">Acceso pendiente</h1>
          <p className="text-sm text-base-content/70">{description}</p>
          <button
            type="button"
            className="btn btn-ghost mt-2"
            onClick={signOut}
            disabled={isSigningOut}
          >
            <LogOut className="size-4" aria-hidden="true" />
            {isSigningOut ? "Cerrando sesión…" : "Cerrar sesión"}
          </button>
        </div>
      </section>
    </main>
  );
}
