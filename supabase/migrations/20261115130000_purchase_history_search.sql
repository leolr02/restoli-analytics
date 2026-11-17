-- Add literal text search across readable branch histories and purchase lines.
DROP FUNCTION IF EXISTS public.get_purchase_import_history(integer);
DROP FUNCTION IF EXISTS public.get_purchase_import_history(integer, text);

CREATE FUNCTION public.get_purchase_import_history(
  p_page integer,
  p_search text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allowed_schemas text[];
  v_schema_name text;
  v_union_sql text;
  v_offset integer;
  v_search text := NULLIF(pg_catalog.btrim(p_search), '');
  v_result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Debes iniciar sesión para consultar el historial.'
      USING ERRCODE = '42501';
  END IF;

  IF p_page IS NULL OR p_page < 1 OR p_page > 1000000 THEN
    RAISE EXCEPTION 'El número de página no es válido.'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(COALESCE(v_search, '')) > 200 THEN
    RAISE EXCEPTION 'El término de búsqueda no puede exceder 200 caracteres.'
      USING ERRCODE = '22023';
  END IF;

  v_offset := (p_page - 1) * 100;

  IF (SELECT private.is_root()) THEN
    SELECT pg_catalog.array_agg(branch.schema_name::text ORDER BY branch.schema_name)
    INTO v_allowed_schemas
    FROM public.empresas_esquemas AS branch
    WHERE pg_catalog.to_regnamespace(branch.schema_name::text) IS NOT NULL;
  ELSE
    SELECT pg_catalog.array_agg(allowed.schema_name ORDER BY allowed.schema_name)
    INTO v_allowed_schemas
    FROM (
      SELECT DISTINCT branch.schema_name::text AS schema_name
      FROM public.user_access_profiles AS profile
      JOIN public.user_branch_access AS branch
        ON branch.user_id = profile.user_id
      JOIN public.profile_table_permissions AS permission
        ON permission.profile_key = profile.profile_key
       AND permission.schema_name = branch.schema_name
       AND permission.table_name = 'purchase_import_jobs'
       AND permission.can_select
      JOIN public.empresas_esquemas AS registered_branch
        ON registered_branch.schema_name = branch.schema_name
      WHERE profile.user_id = (SELECT auth.uid())
        AND pg_catalog.to_regnamespace(branch.schema_name::text) IS NOT NULL
    ) AS allowed;
  END IF;

  IF COALESCE(pg_catalog.array_length(v_allowed_schemas, 1), 0) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'totalCount', 0,
      'page', p_page,
      'pageSize', 100,
      'items', '[]'::jsonb
    );
  END IF;

  FOREACH v_schema_name IN ARRAY v_allowed_schemas
  LOOP
    v_union_sql := pg_catalog.concat_ws(
      ' UNION ALL ',
      v_union_sql,
      pg_catalog.format($branch_query$
        SELECT %L::text AS schema_name,
               job.id, job.status, job.created_at, job.processed_at, job.replicated_at,
               job.local_purchase_id, job.last_error,
               COALESCE(job.header_payload->>'supplier_name', supplier.nombre)::text AS supplier_name,
               job.header_payload,
               pg_catalog.concat_ws(
                 ' ',
                 %L::text,
                 pg_catalog.replace(%L::text, '_', ' '),
                 job.id::text,
                 job.status,
                 CASE job.status
                   WHEN 'pending' THEN 'Pendiente de recepción'
                   WHEN 'processing' THEN 'Procesando en sucursal'
                   WHEN 'local_processed' THEN 'Procesada localmente'
                   WHEN 'replicated' THEN 'Sincronizada'
                   WHEN 'failed' THEN 'Error de procesamiento'
                   ELSE job.status
                 END,
                 job.created_at::text,
                 COALESCE(job.processed_at::text, ''),
                 COALESCE(job.replicated_at::text, ''),
                 COALESCE(job.local_purchase_id::text, ''),
                 COALESCE(job.last_error, ''),
                 COALESCE(supplier.nombre, ''),
                 COALESCE(job.header_payload::text, ''),
                 COALESCE(job.items_payload::text, '')
               ) AS search_text
        FROM %I.purchase_import_jobs AS job
        LEFT JOIN %I.inv_proveedores AS supplier
          ON supplier.id::text = job.header_payload->>'supplier_id'
      $branch_query$,
      v_schema_name,
      v_schema_name,
      v_schema_name,
      v_schema_name,
      v_schema_name)
    );
  END LOOP;

  EXECUTE pg_catalog.format($history_query$
    WITH all_jobs AS (%s),
    filtered_jobs AS (
      SELECT *
      FROM all_jobs
      WHERE $3 IS NULL
         OR pg_catalog.strpos(pg_catalog.lower(search_text), pg_catalog.lower($3)) > 0
    ),
    total AS (
      SELECT pg_catalog.count(*)::bigint AS total_count FROM filtered_jobs
    ),
    page_rows AS (
      SELECT schema_name, id, status, created_at, processed_at, replicated_at,
             local_purchase_id, last_error, supplier_name, header_payload
      FROM filtered_jobs
      ORDER BY created_at DESC, schema_name ASC, id DESC
      OFFSET $1
      LIMIT 100
    )
    SELECT pg_catalog.jsonb_build_object(
      'totalCount', total.total_count,
      'page', $2,
      'pageSize', 100,
      'items', COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(page_rows)
            ORDER BY page_rows.created_at DESC, page_rows.schema_name ASC, page_rows.id DESC
          )
          FROM page_rows
        ),
        '[]'::jsonb
      )
    )
    FROM total
  $history_query$, v_union_sql)
  INTO v_result
  USING v_offset, p_page, v_search;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_purchase_import_history(integer, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_purchase_import_history(integer, text)
  TO authenticated;
