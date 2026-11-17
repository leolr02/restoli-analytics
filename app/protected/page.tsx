import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AccessPending } from "@/components/access-pending";
import { PurchaseEntryForm } from "@/components/purchase-entry-form";
import { ProtectedShell } from "@/components/protected-shell";
import { createClient } from "@/lib/supabase/server";

const PROFILE_LABELS: Record<string, string> = {
  root: "Root",
  admin: "Admin",
  gerencia: "Gerencia",
  almacen: "Almacén",
};

export default async function ProtectedPage() {
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

  if (profileError) {
    return (
      <AccessPending description="El control de accesos todavía no está disponible. Contacta al administrador de la plataforma." />
    );
  }
  if (!profile) {
    return <AccessPending />;
  }

  const { data: allBranches, error: branchesError } = await supabase
    .from("empresas_esquemas")
    .select("schema_name")
    .order("schema_name");

  if (branchesError) {
    return (
      <AccessPending description="No se pudo cargar el acceso a sucursales. Contacta a root para revisar tu asignación." />
    );
  }

  let assignedSchemas = (allBranches ?? []).map((branch) => branch.schema_name);
  if (profile.profile_key !== "root") {
    const { data: assignments, error: assignmentsError } = await supabase
      .from("user_branch_access")
      .select("schema_name")
      .eq("user_id", authData.user.id);

    if (assignmentsError) {
      return (
        <AccessPending description="No se pudo verificar tu asignación de sucursales. Contacta a root." />
      );
    }

    const allowed = new Set((assignments ?? []).map((assignment) => assignment.schema_name));
    assignedSchemas = assignedSchemas.filter((schemaName) => allowed.has(schemaName));
  }

  let writableSchemas = assignedSchemas;
  if (profile.profile_key !== "root" && assignedSchemas.length > 0) {
    const { data: writePermissions, error: permissionsError } = await supabase
      .from("profile_table_permissions")
      .select("schema_name")
      .eq("profile_key", profile.profile_key)
      .eq("table_name", "purchase_import_jobs")
      .eq("can_select", true)
      .eq("can_insert", true)
      .in("schema_name", assignedSchemas);

    if (permissionsError) {
      return (
        <AccessPending description="No se pudo verificar tu permiso para registrar compras. Contacta a root." />
      );
    }

    writableSchemas = (writePermissions ?? []).map((permission) => permission.schema_name);
  } else if (profile.profile_key !== "root") {
    writableSchemas = [];
  }

  const isRoot = profile.profile_key === "root";
  const profileLabel = PROFILE_LABELS[profile.profile_key] ?? profile.profile_key;

  return (
    <ProtectedShell
      email={authData.user.email ?? "Correo no disponible"}
      profileLabel={profileLabel}
      isRoot={isRoot}
    >
      <PurchaseEntryForm
        branchSchemas={assignedSchemas}
        writableSchemas={writableSchemas}
        userId={authData.user.id}
        userEmail={authData.user.email ?? ""}
      />
    </ProtectedShell>
  );
}
