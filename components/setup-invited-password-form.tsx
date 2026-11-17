"use client";

import { Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { notify } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

export function SetupInvitedPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const router = useRouter();

  const submitPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password.length < 8) {
      notify.error("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirmation) {
      notify.error("Las contraseñas no coinciden.");
      return;
    }

    setIsSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      setPassword("");
      setConfirmation("");
      notify.success("Contraseña establecida. Tu acceso quedará pendiente hasta que root te asigne permisos.");
      router.replace("/protected");
      router.refresh();
    } catch {
      notify.error("No se pudo establecer la contraseña. Vuelve a abrir el enlace de invitación o solicita uno nuevo a root.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="grid min-h-svh place-items-center bg-base-200 p-4 text-base-content">
      <section className="card w-full max-w-lg border border-base-300 bg-base-100 shadow-xl">
        <div className="card-body gap-5 p-7 sm:p-8">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="size-6" aria-hidden="true" />
          </div>
          <header className="space-y-2">
            <h1 className="text-2xl font-semibold">Establece tu contraseña</h1>
            <p className="text-sm text-base-content/70">
              Después de guardar, root podrá asignarte un perfil y las sucursales a las que tendrás acceso.
            </p>
          </header>

          <form className="space-y-4" onSubmit={submitPassword}>
            <label className="fieldset">
              <span className="fieldset-legend">Contraseña</span>
              <span className="relative block">
                <input
                  className="input w-full border-base-300 bg-base-100 pr-12"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={isSaving}
                />
                <button
                  className="btn btn-ghost btn-sm btn-circle absolute right-1 top-1/2 -translate-y-1/2"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </span>
              <span className="label text-base-content/60">Mínimo 8 caracteres.</span>
            </label>

            <label className="fieldset">
              <span className="fieldset-legend">Confirmar contraseña</span>
              <input
                className="input w-full border-base-300 bg-base-100"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                minLength={8}
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={isSaving}
              />
            </label>

            <button type="submit" className="btn btn-primary w-full" disabled={isSaving}>
              {isSaving ? "Guardando…" : "Guardar contraseña"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
