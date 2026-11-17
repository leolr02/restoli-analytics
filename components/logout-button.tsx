"use client";

import { LoaderCircle, LogOut } from "lucide-react";
import { useState } from "react";
import { notify } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton() {
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (isSigningOut) return;

    setIsSigningOut(true);
    try {
      const { error } = await createClient().auth.signOut({ scope: "local" });

      if (error) throw error;

      window.location.replace("/");
    } catch {
      notify.error("No se pudo cerrar la sesión. Intenta de nuevo.");
      setIsSigningOut(false);
    }
  };

  return (
    <button
      type="button"
      className="btn btn-circle btn-soft btn-md btn-error"
      onClick={handleSignOut}
      disabled={isSigningOut}
      aria-label="Cerrar sesión"
      aria-busy={isSigningOut}
      title="Cerrar sesión"
    >
      {isSigningOut ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <LogOut className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
