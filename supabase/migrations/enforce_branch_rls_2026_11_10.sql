-- Phase 2 is the access cutover. Map the existing Auth users to a profile and
-- at least one assigned branch before applying this migration remotely.

CREATE OR REPLACE FUNCTION private.has_branch_access(p_schema_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN (SELECT private.is_root()) THEN true
    ELSE EXISTS (
      SELECT 1
      FROM public.user_branch_access AS access
      WHERE access.user_id = (SELECT auth.uid())
        AND access.schema_name = p_schema_name
    )
  END;
$$;

CREATE OR REPLACE FUNCTION private.has_table_access(
  p_schema_name text,
  p_table_name text,
  p_operation text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN (SELECT private.is_root()) THEN true
    WHEN p_operation NOT IN ('select', 'insert', 'update', 'delete') THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.user_access_profiles AS user_profile
      JOIN public.user_branch_access AS branch_access
        ON branch_access.user_id = user_profile.user_id
       AND branch_access.schema_name = p_schema_name
      JOIN public.profile_table_permissions AS permission
        ON permission.profile_key = user_profile.profile_key
       AND permission.schema_name = p_schema_name
       AND permission.table_name = p_table_name
      WHERE user_profile.user_id = (SELECT auth.uid())
        AND CASE p_operation
          WHEN 'select' THEN permission.can_select
          WHEN 'insert' THEN permission.can_insert
          WHEN 'update' THEN permission.can_update
          WHEN 'delete' THEN permission.can_delete
          ELSE false
        END
    )
  END;
$$;

CREATE OR REPLACE FUNCTION private.provision_branch_schema(p_schema_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_relation record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.empresas_esquemas AS branch
    WHERE branch.schema_name = p_schema_name
  ) THEN
    RAISE EXCEPTION 'El esquema no está registrado en empresas_esquemas.' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regnamespace(p_schema_name) IS NULL THEN
    RAISE EXCEPTION 'El esquema registrado no existe en PostgreSQL.' USING ERRCODE = '22023';
  END IF;

  EXECUTE pg_catalog.format(
    'REVOKE ALL ON SCHEMA %I FROM PUBLIC, anon', p_schema_name
  );
  EXECUTE pg_catalog.format(
    'GRANT USAGE ON SCHEMA %I TO authenticated', p_schema_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC, anon, authenticated',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC, anon, authenticated',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated',
    p_schema_name
  );

  FOR v_relation IN
    SELECT relation.relname::text AS table_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = p_schema_name
      AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      p_schema_name, v_relation.table_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
      p_schema_name, v_relation.table_name
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO authenticated',
      p_schema_name, v_relation.table_name
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS access_profile_select ON %I.%I',
      p_schema_name, v_relation.table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY access_profile_select ON %I.%I FOR SELECT TO authenticated USING ((SELECT private.has_table_access(%L, %L, %L)))',
      p_schema_name, v_relation.table_name,
      p_schema_name, v_relation.table_name, 'select'
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS access_profile_insert ON %I.%I',
      p_schema_name, v_relation.table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY access_profile_insert ON %I.%I FOR INSERT TO authenticated WITH CHECK ((SELECT private.has_table_access(%L, %L, %L)))',
      p_schema_name, v_relation.table_name,
      p_schema_name, v_relation.table_name, 'insert'
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS access_profile_update ON %I.%I',
      p_schema_name, v_relation.table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY access_profile_update ON %I.%I FOR UPDATE TO authenticated USING ((SELECT private.has_table_access(%L, %L, %L))) WITH CHECK ((SELECT private.has_table_access(%L, %L, %L)))',
      p_schema_name, v_relation.table_name,
      p_schema_name, v_relation.table_name, 'update',
      p_schema_name, v_relation.table_name, 'update'
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS access_profile_delete ON %I.%I',
      p_schema_name, v_relation.table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY access_profile_delete ON %I.%I FOR DELETE TO authenticated USING ((SELECT private.has_table_access(%L, %L, %L)))',
      p_schema_name, v_relation.table_name,
      p_schema_name, v_relation.table_name, 'delete'
    );

    INSERT INTO public.profile_table_permissions (
      profile_key, schema_name, table_name,
      can_select, can_insert, can_update, can_delete
    )
    SELECT
      role_profile.profile_key,
      p_schema_name,
      v_relation.table_name,
      role_profile.profile_key = 'admin'
        OR (role_profile.profile_key = 'almacen' AND v_relation.table_name = ANY (ARRAY[
          'inv_compras', 'inv_detalles_compras', 'inv_abonos_compras',
          'inv_proveedores', 'inv_contactos_proveedores', 'inv_estatus_compras',
          'inv_departamentos_materias_primas', 'inv_lineas_materias_primas',
          'inv_materias_primas', 'inv_materias_primas_marcas',
          'inv_materias_primas_ubicaciones', 'inv_equivalencias', 'inv_zonas_proveedores',
          'unidades_sat', 'perfiles_fiscales', 'perfiles_fiscales_condiciones',
          'perfiles_fiscales_impuestos', 'perfiles_fiscales_versiones',
          'ventas', 'ventas_contexto_fiscal', 'detalle_ventas',
          'detalle_ventas_fiscal', 'detalle_ventas_impuestos', 'detalle_producto',
          'detalle_tarjetas', 'detalle_depositos', 'sesiones_caja',
          'cajas_movimientos', 'cajas', 'clientes', 'telefonos_clientes',
          'tarjetas', 'bancos', 'precios', 'mesas'
        ]::text[])),
      role_profile.profile_key = 'admin'
        OR (role_profile.profile_key = 'almacen' AND v_relation.table_name = ANY (ARRAY[
          'inv_compras', 'inv_detalles_compras', 'inv_abonos_compras'
        ]::text[])),
      role_profile.profile_key = 'admin'
        OR (role_profile.profile_key = 'almacen' AND v_relation.table_name = ANY (ARRAY[
          'inv_compras', 'inv_detalles_compras', 'inv_abonos_compras'
        ]::text[])),
      role_profile.profile_key = 'admin'
        OR (role_profile.profile_key = 'almacen' AND v_relation.table_name = ANY (ARRAY[
          'inv_compras', 'inv_detalles_compras', 'inv_abonos_compras'
        ]::text[]))
    FROM (VALUES ('admin'), ('gerencia'), ('almacen')) AS role_profile(profile_key)
    ON CONFLICT (profile_key, schema_name, table_name) DO NOTHING;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.has_branch_access(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.has_table_access(text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.provision_branch_schema(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.has_branch_access(text),
  private.has_table_access(text, text, text)
  TO authenticated;

ALTER TABLE public.empresas_esquemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.empresas_esquemas FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.empresas_esquemas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.empresas_esquemas TO authenticated;

DROP POLICY IF EXISTS assigned_branches_read ON public.empresas_esquemas;
CREATE POLICY assigned_branches_read
  ON public.empresas_esquemas FOR SELECT TO authenticated
  USING ((SELECT private.has_branch_access(schema_name::text)));

DO $$
DECLARE
  v_schema record;
BEGIN
  FOR v_schema IN
    SELECT branch.schema_name::text AS schema_name
    FROM public.empresas_esquemas AS branch
    ORDER BY branch.schema_name
  LOOP
    PERFORM private.provision_branch_schema(v_schema.schema_name);
  END LOOP;
END;
$$;
