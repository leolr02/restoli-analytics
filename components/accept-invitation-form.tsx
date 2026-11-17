"use client";

import { LoaderCircle, MailCheck } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { notify } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

export function AcceptInvitationForm({ tokenHash }: { tokenHash: string }) {
  const [isAccepting, setIsAccepting] = useState(false);
  const router = useRouter();

  const acceptInvitation = async () => {
    if (isAccepting) return;
    setIsAccepting(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "invite",
      });

      if (error) throw error;

      router.replace("/auth/setup-password");
      router.refresh();
    } catch {
      notify.error("La invitación no es válida o venció. Solicita a root que envíe otra.");
      setIsAccepting(false);
    }
  };

  return (
    <main className="grid min-h-svh place-items-center bg-base-200 p-4 text-base-content">
      <section className="card w-full max-w-lg border border-base-300 bg-base-100 shadow-xl">
        <div className="card-body items-center gap-5 p-7 text-center sm:p-8">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MailCheck className="size-6" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">Aceptar invitación</h1>
            <p className="text-sm text-base-content/70">
              Confirma la invitación para crear tu sesión y después establecer tu contraseña.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={() => void acceptInvitation()}
            disabled={isAccepting}
          >
            {isAccepting ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <MailCheck className="size-4" aria-hidden="true" />
            )}
            {isAccepting ? "Aceptando…" : "Aceptar invitación"}
          </button>
        </div>
      </section>
    </main>
  );
}
