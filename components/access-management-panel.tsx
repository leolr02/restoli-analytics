"use client";

import {
  Building2,
  LoaderCircle,
  MailPlus,
  Save,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { notify } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

const EDITABLE_PROFILES = ["admin", "gerencia", "almacen"] as const;
type EditableProfile = (typeof EDITABLE_PROFILES)[number];
type ProfileKey = EditableProfile | "root";
type PermissionKey = "can_select" | "can_insert" | "can_update" | "can_delete";

type AccessUser = {
  user_id: string;
  email: string | null;
  created_at: string;
  profile_key: ProfileKey | null;
  branch_schemas: string[];
};

type TablePermission = {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
};

const PROFILE_LABELS: Record<ProfileKey, string> = {
  root: "Root",
  admin: "Admin",
  gerencia: "Gerencia",
  almacen: "Almacén",
};

const PERMISSIONS: { key: PermissionKey; label: string }[] = [
  { key: "can_select", label: "Leer" },
  { key: "can_insert", label: "Insertar" },
  { key: "can_update", label: "Actualizar" },
  { key: "can_delete", label: "Borrar" },
];

function formatSchemaName(schemaName: string) {
  return schemaName.replaceAll("_", " ");
}

export function AccessManagementPanel({
  schemas,
}: {
  schemas: string[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [activeTab, setActiveTab] = useState<"users" | "permissions">("users");
  const [inviteEmail, setInviteEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<EditableProfile>("almacen");
  const [selectedSchema, setSelectedSchema] = useState(schemas[0] ?? "");
  const [matrix, setMatrix] = useState<TablePermission[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixSaving, setMatrixSaving] = useState(false);
  const [matrixDirty, setMatrixDirty] = useState(false);
  const [tableSearch, setTableSearch] = useState("");

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    const { data, error } = await supabase.rpc("root_list_users");
    setUsersLoading(false);

    if (error) {
      notify.error("No se pudo cargar la lista de usuarios.");
      return;
    }
    setUsers((data ?? []) as unknown as AccessUser[]);
  }, [supabase]);

  const sendInvitation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsInviting(true);

    try {
      const response = await fetch("/api/access/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      const result = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(result.error || "No se pudo enviar la invitación.");
      }

      setInviteEmail("");
      notify.success("Invitación enviada por correo.");
      await loadUsers();
    } catch (error) {
      notify.error(
        error instanceof Error ? error.message : "No se pudo enviar la invitación.",
      );
    } finally {
      setIsInviting(false);
    }
  };

  const loadMatrix = useCallback(async () => {
    if (!selectedSchema) {
      setMatrix([]);
      return;
    }

    setMatrixLoading(true);
    setMatrixDirty(false);
    const { data, error } = await supabase.rpc("root_list_profile_matrix", {
      p_profile_key: selectedProfile,
      p_schema_name: selectedSchema,
    });
    setMatrixLoading(false);

    if (error) {
      notify.error("No se pudo cargar la matriz de permisos.");
      setMatrix([]);
      return;
    }
    setMatrix((data ?? []) as unknown as TablePermission[]);
  }, [selectedProfile, selectedSchema, supabase]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  const changeProfile = async (user: AccessUser, profileKey: string) => {
    setSavingUserId(user.user_id);
    const { error } = profileKey
      ? await supabase.rpc("root_set_user_profile", {
          p_user_id: user.user_id,
          p_profile_key: profileKey,
        })
      : await supabase.rpc("root_remove_user_access", {
          p_user_id: user.user_id,
        });
    setSavingUserId(null);

    if (error) {
      notify.error(error.message || "No se pudo actualizar el perfil.");
      return;
    }

    notify.success(profileKey ? "Perfil actualizado." : "Acceso revocado.");
    await loadUsers();
  };

  const changeUserBranches = async (
    user: AccessUser,
    schemaName: string,
    checked: boolean,
  ) => {
    if (!user.profile_key || user.profile_key === "root") return;

    const nextSchemas = checked
      ? [...new Set([...user.branch_schemas, schemaName])]
      : user.branch_schemas.filter((assignedSchema) => assignedSchema !== schemaName);

    setSavingUserId(user.user_id);
    const { error } = await supabase.rpc("root_set_user_branches", {
      p_user_id: user.user_id,
      p_schema_names: nextSchemas,
    });
    setSavingUserId(null);

    if (error) {
      notify.error(error.message || "No se pudieron actualizar las sucursales.");
      return;
    }

    setUsers((current) =>
      current.map((entry) =>
        entry.user_id === user.user_id
          ? { ...entry, branch_schemas: nextSchemas }
          : entry,
      ),
    );
    notify.success("Sucursales actualizadas.");
  };

  const togglePermission = (
    tableName: string,
    permissionKey: PermissionKey,
    checked: boolean,
  ) => {
    setMatrix((current) =>
      current.map((permission) => {
        if (permission.table_name !== tableName) return permission;
        const updated = { ...permission, [permissionKey]: checked };

        if (permissionKey === "can_update" && checked) {
          updated.can_select = true;
        }
        if (permissionKey === "can_select" && !checked) {
          updated.can_update = false;
        }

        return updated;
      }),
    );
    setMatrixDirty(true);
  };

  const saveMatrix = async () => {
    setMatrixSaving(true);
    const { error } = await supabase.rpc("root_save_profile_matrix", {
      p_profile_key: selectedProfile,
      p_schema_name: selectedSchema,
      p_permissions: matrix,
    });
    setMatrixSaving(false);

    if (error) {
      notify.error(error.message || "No se pudieron guardar los permisos.");
      return;
    }

    notify.success("Permisos guardados.");
    setMatrixDirty(false);
    await loadMatrix();
  };

  const visibleMatrix = matrix.filter((permission) =>
    permission.table_name.toLowerCase().includes(tableSearch.trim().toLowerCase()),
  );

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 text-sm font-medium text-primary">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Administración de root
          </div>
          <h1 className="text-3xl font-bold">Control de accesos</h1>
          <p className="mt-1 max-w-2xl text-sm text-base-content/70">
            Asigna perfiles y sucursales a los usuarios de Auth y configura permisos CRUD por tabla.
          </p>
        </div>
        <div className="badge badge-primary badge-outline gap-2 self-start sm:self-auto">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Root: acceso global
        </div>
      </header>

      <div role="tablist" className="tabs tabs-boxed w-fit max-w-full">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "users"}
          className={`tab gap-2 ${activeTab === "users" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("users")}
        >
          <Users className="size-4" aria-hidden="true" />
          Usuarios y sucursales
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "permissions"}
          className={`tab gap-2 ${activeTab === "permissions" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("permissions")}
        >
          <Building2 className="size-4" aria-hidden="true" />
          Permisos por tabla
        </button>
      </div>

      {activeTab === "users" ? (
        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-5 p-4 sm:p-6">
            <div>
              <h2 className="card-title">Usuarios registrados en Auth</h2>
              <p className="text-sm text-base-content/70">
                Cada usuario tiene un perfil. Root asigna sus sucursales; sin perfil o sucursal no hay acceso a datos.
              </p>
            </div>

            <form
              className="rounded-box border border-base-300 bg-base-200/40 p-4"
              onSubmit={sendInvitation}
            >
              <fieldset className="fieldset">
                <legend className="fieldset-legend">Invitar usuario por correo</legend>
                <div className="flex w-full">
                  <input
                    className="input min-w-0 flex-1 rounded-r-none border-base-300 bg-base-100"
                    type="email"
                    autoComplete="email"
                    placeholder="persona@ejemplo.com"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    required
                    maxLength={254}
                    disabled={isInviting}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary -ml-px shrink-0 rounded-l-none"
                    disabled={isInviting}
                  >
                    {isInviting ? (
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <MailPlus className="size-4" aria-hidden="true" />
                    )}
                    {isInviting ? "Enviando…" : "Enviar invitación"}
                  </button>
                </div>
                <p className="label text-base-content/60">
                  La invitación crea la cuenta sin perfil ni sucursales; root los asigna desde esta pantalla.
                </p>
              </fieldset>
            </form>

            {usersLoading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-base-content/70">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                Cargando usuarios…
              </div>
            ) : users.length === 0 ? (
              <p className="py-8 text-sm text-base-content/70">No hay usuarios de Auth para mostrar.</p>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {users.map((user) => {
                  const isRoot = user.profile_key === "root";
                  const isSaving = savingUserId === user.user_id;

                  return (
                    <article
                      key={user.user_id}
                      className="rounded-box border border-base-300 bg-base-200/40 p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="break-all font-semibold">
                            {user.email || `Usuario ${user.user_id.slice(0, 8)}`}
                          </p>
                          {isRoot ? (
                            <p className="mt-1 text-xs text-primary">Cuenta root única · acceso global</p>
                          ) : (
                            <p className="mt-1 text-xs text-base-content/60">
                              {user.profile_key
                                ? `Perfil: ${PROFILE_LABELS[user.profile_key]}`
                                : "Sin perfil asignado"}
                            </p>
                          )}
                        </div>
                        <fieldset className="fieldset w-full max-w-xs">
                          <legend className="fieldset-legend">Perfil</legend>
                          <select
                            className="select select-sm w-full border-base-300 bg-base-100"
                            value={user.profile_key ?? ""}
                            disabled={isRoot || isSaving}
                            onChange={(event) => void changeProfile(user, event.target.value)}
                          >
                            <option value="">Sin acceso</option>
                            {isRoot ? <option value="root">Root (único)</option> : null}
                            {EDITABLE_PROFILES.map((profile) => (
                              <option key={profile} value={profile}>
                                {PROFILE_LABELS[profile]}
                              </option>
                            ))}
                          </select>
                        </fieldset>
                      </div>

                      <fieldset
                        disabled={!user.profile_key || isRoot || isSaving}
                        className="mt-4 border-t border-base-300 pt-3 disabled:opacity-50"
                      >
                        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">
                          Sucursales asignadas
                        </legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {schemas.map((schemaName) => (
                            <label
                              key={schemaName}
                              className="label cursor-pointer justify-start gap-3 rounded-field px-2 py-1"
                            >
                              <input
                                type="checkbox"
                                className="checkbox checkbox-primary checkbox-sm"
                                checked={user.branch_schemas.includes(schemaName)}
                                onChange={(event) =>
                                  void changeUserBranches(user, schemaName, event.target.checked)
                                }
                              />
                              <span className="label-text capitalize">
                                {formatSchemaName(schemaName)}
                              </span>
                            </label>
                          ))}
                          {schemas.length === 0 ? (
                            <p className="text-sm text-base-content/60">
                              No hay sucursales registradas.
                            </p>
                          ) : null}
                        </div>
                      </fieldset>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-5 p-4 sm:p-6">
            <div>
              <h2 className="card-title">Permisos de tabla por perfil</h2>
              <p className="text-sm text-base-content/70">
                Los permisos se aplican en la base de datos. La matriz combina sucursal, perfil y operación.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_1fr_2fr_auto] md:items-end">
              <fieldset className="fieldset">
                <legend className="fieldset-legend">Perfil editable</legend>
                <select
                  className="select w-full border-base-300 bg-base-100"
                  value={selectedProfile}
                  onChange={(event) => setSelectedProfile(event.target.value as EditableProfile)}
                >
                  {EDITABLE_PROFILES.map((profile) => (
                    <option key={profile} value={profile}>
                      {PROFILE_LABELS[profile]}
                    </option>
                  ))}
                </select>
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset-legend">Sucursal</legend>
                <select
                  className="select w-full border-base-300 bg-base-100"
                  value={selectedSchema}
                  onChange={(event) => setSelectedSchema(event.target.value)}
                  disabled={schemas.length === 0}
                >
                  {schemas.map((schemaName) => (
                    <option key={schemaName} value={schemaName}>
                      {formatSchemaName(schemaName)}
                    </option>
                  ))}
                </select>
              </fieldset>

              <label className="input w-full border-base-300 bg-base-100">
                <Search className="size-4 opacity-60" aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Filtrar tablas"
                  value={tableSearch}
                  onChange={(event) => setTableSearch(event.target.value)}
                />
              </label>

              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveMatrix()}
                disabled={!matrixDirty || matrixSaving || matrixLoading || !selectedSchema}
              >
                {matrixSaving ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
                Guardar cambios
              </button>
            </div>

            {matrixLoading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-base-content/70">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                Cargando tablas…
              </div>
            ) : matrix.length === 0 ? (
              <p className="py-8 text-sm text-base-content/70">
                No se encontraron tablas para esta sucursal.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-box border border-base-300">
                <table className="table table-zebra">
                  <thead>
                    <tr>
                      <th>Tabla</th>
                      {PERMISSIONS.map((permission) => (
                        <th key={permission.key} className="text-center">{permission.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMatrix.map((permission) => (
                      <tr key={permission.table_name}>
                        <th className="font-mono text-xs">{permission.table_name}</th>
                        {PERMISSIONS.map((operation) => (
                          <td key={operation.key} className="text-center">
                            <input
                              type="checkbox"
                              className="checkbox checkbox-primary checkbox-sm"
                              checked={permission[operation.key]}
                              aria-label={`${operation.label}: ${permission.table_name}`}
                              onChange={(event) =>
                                togglePermission(
                                  permission.table_name,
                                  operation.key,
                                  event.target.checked,
                                )
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                    {visibleMatrix.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-sm text-base-content/60">
                          No hay tablas que coincidan con la búsqueda.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-xs text-base-content/60">
              Al activar Actualizar también se habilita Lectura, requisito de RLS para actualizar filas.
            </p>
          </div>
        </section>
      )}
    </section>
  );
}
