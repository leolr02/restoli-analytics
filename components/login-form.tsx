"use client";

import { Eye, EyeOff } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { notify } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        throw authError;
      }

      setPassword("");
      router.replace("/protected");
    } catch (error) {
      setPassword("");
      console.error("Supabase sign-in failed", error);
      notify.error(
        process.env.NODE_ENV === "development" && error instanceof Error
          ? `No se pudo iniciar sesión: ${error.message}`
          : "No se pudo iniciar sesión. Verifica tus credenciales e inténtalo de nuevo.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="card w-full border border-base-300 bg-base-100 shadow-xl">
      <div className="card-body gap-6 p-7 sm:p-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold text-primary/50">
            Iniciar sesión
          </h1>
          <p className="text-sm font-light text-base-content/70">
            Ingresa tu correo electrónico y contraseña para acceder.
          </p>
        </header>

        <form method="post" onSubmit={handleLogin}>
          <div className="flex justify-center py-1">
            <Image
                src="/logo.png"
                alt="Restoli Analytics"
                width={112}
                height={90}
                priority
                className="h-auto w-24 object-contain"
            />
          </div>
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="email">
                Correo electrónico
              </label>
              <input
                className="input border-base-300 w-full bg-base-100"
                id="email"
                type="email"
                placeholder="correo@ejemplo.com"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="password">
                Contraseña
              </label>
              <div className="relative">
                <input
                  className="input border-base-300 w-full bg-base-100 pr-12"
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  className="btn btn-ghost btn-sm btn-circle absolute right-1 top-1/2 -translate-y-1/2"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  aria-pressed={showPassword}
                  aria-controls="password"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <button
              className="btn btn-primary w-full rounded-full"
              type="submit"
              disabled={isLoading}
            >
              {isLoading ? "Iniciando sesión..." : "Iniciar sesión"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
