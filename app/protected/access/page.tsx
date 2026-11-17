import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { AccessManagementPanel } from "@/components/access-management-panel";
import { LogoutButton } from "@/components/logout-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { createClient } from "@/lib/supabase/server";

export default async function AccessManagementPage() {
  await connection();

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    redirect("/");
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_access_profiles")
    .select("profile_key")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (profileError || profile?.profile_key !== "root") {
    notFound();
  }

  const { data: branches, error: branchError } = await supabase
    .from("empresas_esquemas")
    .select("schema_name")
    .order("schema_name");

  if (branchError) {
    throw new Error("No se pudo cargar el catálogo de sucursales.");
  }

  const schemas = (branches ?? []).map((branch) => branch.schema_name);

  return (
    <main className="min-h-svh bg-base-200 text-base-content">
      <header className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100 px-3 sm:px-5">
        <div className="flex-1 gap-3">
          <Image
            src="/logo.png"
            alt="Restoli Analytics"
            width={72}
            height={58}
            className="h-10 w-auto object-contain"
          />
          <div className="hidden sm:block">
            <p className="text-sm font-semibold">Restoli Analytics</p>
            <p className="text-xs text-base-content/60">Administración de accesos</p>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Link href="/protected" className="btn btn-ghost btn-sm">
            <ArrowLeft className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Volver a Compras</span>
          </Link>
          <LogoutButton />
          <ThemeToggle />
        </div>
      </header>

      <div className="border-b border-base-300 bg-base-100/80 px-4 py-3 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center gap-2 text-sm text-primary">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Solo la cuenta root puede administrar usuarios y permisos.
        </div>
      </div>

      <AccessManagementPanel schemas={schemas} />
    </main>
  );
}
