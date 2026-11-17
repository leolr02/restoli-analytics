-- Allow users who can enqueue a purchase to read package equivalencies in their
-- assigned branch. This migration updates branch schemas already provisioned.
DO $$
DECLARE
  v_branch record;
BEGIN
  FOR v_branch IN
    SELECT branch.schema_name::text AS schema_name
    FROM public.empresas_esquemas AS branch
    ORDER BY branch.schema_name
  LOOP
    IF pg_catalog.to_regclass(
      pg_catalog.format('%I.inv_equivalencias', v_branch.schema_name)
    ) IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.profile_table_permissions (
      profile_key,
      schema_name,
      table_name,
      can_select,
      can_insert,
      can_update,
      can_delete
    )
    VALUES
      ('admin', v_branch.schema_name, 'inv_equivalencias', true, true, true, true),
      ('almacen', v_branch.schema_name, 'inv_equivalencias', true, false, false, false)
    ON CONFLICT (profile_key, schema_name, table_name)
    DO UPDATE SET
      can_select = true,
      updated_at = pg_catalog.now();

    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE %I.inv_equivalencias TO authenticated',
      v_branch.schema_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.inv_equivalencias ENABLE ROW LEVEL SECURITY',
      v_branch.schema_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.inv_equivalencias FORCE ROW LEVEL SECURITY',
      v_branch.schema_name
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS access_profile_select ON %I.inv_equivalencias',
      v_branch.schema_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY access_profile_select ON %I.inv_equivalencias FOR SELECT TO authenticated USING ((SELECT private.has_table_access(%L, %L, %L)))',
      v_branch.schema_name,
      v_branch.schema_name,
      'inv_equivalencias',
      'select'
    );
  END LOOP;
END;
$$;
