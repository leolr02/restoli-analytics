-- Inbound cloud purchase queue. Each branch gets its own queue table and
-- branch-scoped worker RPCs; canonical inv_compras tables remain WAL output.

CREATE TABLE IF NOT EXISTS public.purchase_import_workers (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  schema_name text NOT NULL REFERENCES public.empresas_esquemas (schema_name)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.purchase_import_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_import_workers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.purchase_import_workers
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_purchase_import_worker(p_schema_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.purchase_import_workers AS worker
      WHERE worker.user_id = (SELECT auth.uid())
        AND worker.schema_name = p_schema_name
    );
$$;

REVOKE ALL ON FUNCTION private.is_purchase_import_worker(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_purchase_import_worker(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.enqueue_purchase_import_job(
  p_schema_name text,
  p_job_id uuid,
  p_header_payload jsonb,
  p_items_payload jsonb,
  p_document_path text
)
RETURNS TABLE (id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
  v_existing_user uuid;
  v_existing_status text;
  v_item jsonb;
  v_item_count integer := 0;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_taxes numeric := 0;
  v_total numeric := 0;
  v_line_subtotal numeric;
  v_line_discount numeric;
  v_line_taxes numeric;
  v_line_amount numeric;
  v_other_expenses numeric;
  v_advance numeric;
BEGIN
  IF (SELECT auth.uid()) IS NULL
     OR NOT private.has_table_access(p_schema_name, 'purchase_import_jobs', 'insert')
     OR NOT EXISTS (
       SELECT 1 FROM public.empresas_esquemas AS branch
       WHERE branch.schema_name = p_schema_name
     )
     OR pg_catalog.to_regnamespace(p_schema_name) IS NULL THEN
    RAISE EXCEPTION 'No tienes permiso para encolar compras en esta sucursal.'
      USING ERRCODE = '42501';
  END IF;

  IF p_job_id IS NULL
     OR pg_catalog.jsonb_typeof(p_header_payload) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_items_payload) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'El encabezado o los productos de la compra no son válidos.'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_items_payload) < 1
     OR pg_catalog.jsonb_array_length(p_items_payload) > 500 THEN
    RAISE EXCEPTION 'La compra debe incluir de 1 a 500 productos.'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_header_payload->>'purchase_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR COALESCE(p_header_payload->>'reception_date', '') IS DISTINCT FROM COALESCE(p_header_payload->>'purchase_date', '')
     OR COALESCE(p_header_payload->>'payment_method', '') NOT IN ('EFECTIVO', 'CREDITO')
     OR COALESCE(p_header_payload->>'invoiced_status', '') NOT IN ('A', 'P')
     OR COALESCE(p_header_payload->>'supplier_id', '') !~ '^[1-9][0-9]*$'
     OR COALESCE(p_header_payload->>'advance', '') !~ '^[0-9]+(\.[0-9]+)?$'
     OR COALESCE(p_header_payload->>'other_expenses', '') !~ '^[0-9]+(\.[0-9]+)?$'
     OR COALESCE(p_header_payload->>'subtotal', '') !~ '^[0-9]+(\.[0-9]+)?$'
     OR COALESCE(p_header_payload->>'discount', '') !~ '^[0-9]+(\.[0-9]+)?$'
     OR COALESCE(p_header_payload->>'taxes', '') !~ '^[0-9]+(\.[0-9]+)?$'
     OR COALESCE(p_header_payload->>'total', '') !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'Los campos requeridos del encabezado no son válidos.'
      USING ERRCODE = '22023';
  END IF;

  IF p_header_payload->>'ticket_number' IS NOT NULL
     AND p_header_payload->>'ticket_number' !~ '^[A-Za-z0-9_#-]{3,50}$' THEN
    RAISE EXCEPTION 'El No. Ticket no cumple el formato permitido.'
      USING ERRCODE = '22023';
  END IF;
  IF p_header_payload->>'invoice_number' IS NOT NULL
     AND p_header_payload->>'invoice_number' !~ '^[A-Za-z0-9_#-]{3,80}$' THEN
    RAISE EXCEPTION 'El No. Factura no cumple el formato permitido.'
      USING ERRCODE = '22023';
  END IF;
  IF p_header_payload->>'payment_method' = 'CREDITO'
     AND p_header_payload->>'payment_days' IS NOT NULL
     AND p_header_payload->>'payment_days' !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'La frecuencia de pago debe ser un entero no negativo.'
      USING ERRCODE = '22023';
  END IF;

  IF p_document_path IS NOT NULL AND p_document_path NOT IN (
    p_schema_name || '/' || (SELECT auth.uid()::text) || '/' || p_job_id::text || '.png',
    p_schema_name || '/' || (SELECT auth.uid()::text) || '/' || p_job_id::text || '.jpg',
    p_schema_name || '/' || (SELECT auth.uid()::text) || '/' || p_job_id::text || '.jpeg',
    p_schema_name || '/' || (SELECT auth.uid()::text) || '/' || p_job_id::text || '.pdf',
    p_schema_name || '/' || (SELECT auth.uid()::text) || '/' || p_job_id::text || '.xml'
  ) THEN
    RAISE EXCEPTION 'La ruta del documento no corresponde a este trabajo y usuario.'
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT item.value FROM pg_catalog.jsonb_array_elements(p_items_payload) AS item(value)
  LOOP
    v_item_count := v_item_count + 1;
    IF pg_catalog.jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'El producto % no contiene valores válidos.', v_item_count
        USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_item->>'product_id', '') !~ '^[1-9][0-9]*$'
       OR pg_catalog.jsonb_typeof(v_item->'quantity') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_item->'subtotal') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_item->'discount') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_item->'taxes') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_item->'amount') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'El producto % no contiene valores numéricos válidos.', v_item_count
        USING ERRCODE = '22023';
    END IF;
    IF (v_item->>'quantity')::numeric <= 0
       OR (v_item->>'subtotal')::numeric < 0
       OR (v_item->>'discount')::numeric < 0
       OR (v_item->>'taxes')::numeric < 0 THEN
      RAISE EXCEPTION 'El producto % no contiene valores válidos.', v_item_count
        USING ERRCODE = '22023';
    END IF;
    v_line_subtotal := (v_item->>'subtotal')::numeric;
    v_line_discount := (v_item->>'discount')::numeric;
    v_line_taxes := (v_item->>'taxes')::numeric;
    v_line_amount := (v_item->>'amount')::numeric;
    IF v_line_amount <> pg_catalog.round(v_line_subtotal - v_line_discount + v_line_taxes, 2) THEN
      RAISE EXCEPTION 'El importe del producto % no coincide con sus conceptos.', v_item_count
        USING ERRCODE = '22023';
    END IF;
    v_subtotal := v_subtotal + v_line_subtotal;
    v_discount := v_discount + v_line_discount;
    v_taxes := v_taxes + v_line_taxes;
    v_total := v_total + v_line_amount;
  END LOOP;

  v_other_expenses := (p_header_payload->>'other_expenses')::numeric;
  v_advance := (p_header_payload->>'advance')::numeric;
  v_total := pg_catalog.round(v_total + v_other_expenses, 2);
  IF (p_header_payload->>'subtotal')::numeric <> pg_catalog.round(v_subtotal, 2)
     OR (p_header_payload->>'discount')::numeric <> pg_catalog.round(v_discount, 2)
     OR (p_header_payload->>'taxes')::numeric <> pg_catalog.round(v_taxes, 2)
     OR (p_header_payload->>'total')::numeric <> v_total
     OR (p_header_payload->>'payment_method') = 'CREDITO' AND v_advance >= v_total THEN
    RAISE EXCEPTION 'Los totales o el anticipo de la compra no son consistentes.'
      USING ERRCODE = '22023';
  END IF;

  EXECUTE pg_catalog.format(
    'INSERT INTO %I.purchase_import_jobs (
       id, header_payload, items_payload, document_path, created_by
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING',
    p_schema_name
  ) USING p_job_id, p_header_payload, p_items_payload, p_document_path, auth.uid();

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    EXECUTE pg_catalog.format(
      'SELECT created_by, status FROM %I.purchase_import_jobs WHERE id = $1',
      p_schema_name
    ) INTO v_existing_user, v_existing_status USING p_job_id;
    IF v_existing_user IS DISTINCT FROM (SELECT auth.uid()) THEN
      RAISE EXCEPTION 'El identificador de solicitud ya está en uso.'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_job_id, v_existing_status;
    RETURN;
  END IF;

  RETURN QUERY SELECT p_job_id, 'pending'::text;
END;
$$;

REVOKE ALL ON FUNCTION private.enqueue_purchase_import_job(text, uuid, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.claim_purchase_import_job(p_schema_name text)
RETURNS TABLE (
  id uuid,
  payload_version smallint,
  header_payload jsonb,
  items_payload jsonb,
  document_path text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active_job boolean;
BEGIN
  IF NOT private.is_purchase_import_worker(p_schema_name)
     OR NOT EXISTS (
       SELECT 1 FROM public.empresas_esquemas AS branch
       WHERE branch.schema_name = p_schema_name
     )
     OR pg_catalog.to_regnamespace(p_schema_name) IS NULL THEN
    RAISE EXCEPTION 'El consumidor no está asignado a este esquema.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(p_schema_name, 0)
  ) THEN
    RETURN;
  END IF;

  EXECUTE pg_catalog.format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.purchase_import_jobs
       WHERE status = ''processing'' AND locked_until > pg_catalog.now()
     )',
    p_schema_name
  ) INTO v_active_job;
  IF v_active_job THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE pg_catalog.format(
    'WITH candidate AS (
       SELECT job.id
       FROM %I.purchase_import_jobs AS job
       WHERE (job.status = ''pending'' AND job.available_at <= pg_catalog.now())
          OR (job.status = ''processing'' AND job.locked_until <= pg_catalog.now())
       ORDER BY CASE WHEN job.status = ''processing'' THEN 0 ELSE 1 END,
         job.created_at, job.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE %I.purchase_import_jobs AS job
     SET status = ''processing'',
         attempt_count = job.attempt_count + 1,
         locked_by = $1,
         locked_until = pg_catalog.now() + interval ''30 minutes'',
         last_error = NULL
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.payload_version, job.header_payload,
       job.items_payload, job.document_path, job.attempt_count',
    p_schema_name,
    p_schema_name
  ) USING auth.uid()::text;
END;
$$;

CREATE OR REPLACE FUNCTION private.acknowledge_purchase_import_job(
  p_schema_name text,
  p_job_id uuid,
  p_local_purchase_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
  v_status text;
  v_local_purchase_id bigint;
BEGIN
  IF NOT private.is_purchase_import_worker(p_schema_name)
     OR p_job_id IS NULL
     OR p_local_purchase_id IS NULL
     OR p_local_purchase_id <= 0 THEN
    RAISE EXCEPTION 'El consumidor o el resultado local no es válido.'
      USING ERRCODE = '42501';
  END IF;

  EXECUTE pg_catalog.format(
    'UPDATE %I.purchase_import_jobs
     SET status = ''local_processed'',
         local_purchase_id = $2,
         processed_at = pg_catalog.now(),
         locked_by = NULL,
         locked_until = NULL,
         last_error = NULL
     WHERE id = $1
       AND status = ''processing''
       AND locked_by = $3',
    p_schema_name
  ) USING p_job_id, p_local_purchase_id, auth.uid()::text;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 0 THEN
    RETURN;
  END IF;

  EXECUTE pg_catalog.format(
    'SELECT status, local_purchase_id
     FROM %I.purchase_import_jobs
     WHERE id = $1',
    p_schema_name
  ) INTO v_status, v_local_purchase_id USING p_job_id;

  IF v_status IN ('local_processed', 'replicated')
     AND v_local_purchase_id = p_local_purchase_id THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'El trabajo no está reservado por este consumidor.'
    USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION private.report_purchase_import_failure(
  p_schema_name text,
  p_job_id uuid,
  p_error text,
  p_retryable boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF NOT private.is_purchase_import_worker(p_schema_name) OR p_job_id IS NULL THEN
    RAISE EXCEPTION 'El consumidor no está asignado a este esquema.'
      USING ERRCODE = '42501';
  END IF;

  EXECUTE pg_catalog.format(
    'UPDATE %I.purchase_import_jobs
     SET status = CASE
           WHEN $3 AND attempt_count < 5 THEN ''pending''
           ELSE ''failed''
         END,
         available_at = CASE
           WHEN $3 AND attempt_count < 5 THEN pg_catalog.now() +
             (LEAST(3600, 30 * pg_catalog.power(2, GREATEST(attempt_count - 1, 0)))::integer * interval ''1 second'')
           ELSE available_at
         END,
         last_error = pg_catalog.left(
           COALESCE(NULLIF(pg_catalog.btrim($4), ''''), ''Error de procesamiento sin detalle.''),
           4000
         ),
         locked_by = NULL,
         locked_until = NULL
     WHERE id = $1
       AND status = ''processing''
       AND locked_by = $2',
    p_schema_name
  ) USING p_job_id, auth.uid()::text, COALESCE(p_retryable, false), p_error;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'El trabajo no está reservado por este consumidor.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.mark_purchase_import_replicated(
  p_schema_name text,
  p_job_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
  v_status text;
BEGIN
  IF NOT private.is_purchase_import_worker(p_schema_name) OR p_job_id IS NULL THEN
    RAISE EXCEPTION 'El consumidor no está asignado a este esquema.'
      USING ERRCODE = '42501';
  END IF;

  EXECUTE pg_catalog.format(
    'UPDATE %I.purchase_import_jobs
     SET status = ''replicated'', replicated_at = pg_catalog.now()
     WHERE id = $1 AND status = ''local_processed''',
    p_schema_name
  ) USING p_job_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 0 THEN
    RETURN;
  END IF;

  EXECUTE pg_catalog.format(
    'SELECT status FROM %I.purchase_import_jobs WHERE id = $1',
    p_schema_name
  ) INTO v_status USING p_job_id;

  IF v_status = 'replicated' THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'La compra todavía no está aplicada localmente.'
    USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION private.claim_purchase_import_job(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.acknowledge_purchase_import_job(text, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.report_purchase_import_failure(text, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.mark_purchase_import_replicated(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.provision_purchase_import_queue(p_schema_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status_count integer;
  v_status_sequence text;
  v_status_max_id bigint;
  v_status_sequence_last_value bigint;
  v_status_sequence_is_called boolean;
  v_has_queue_permissions boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.empresas_esquemas AS branch
    WHERE branch.schema_name = p_schema_name
  ) OR pg_catalog.to_regnamespace(p_schema_name) IS NULL THEN
    RAISE EXCEPTION 'El esquema debe existir y estar registrado en empresas_esquemas.'
      USING ERRCODE = '22023';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE TABLE IF NOT EXISTS %I.purchase_import_jobs (
       id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
       status text NOT NULL DEFAULT ''pending''
         CHECK (status IN (''pending'', ''processing'', ''local_processed'', ''replicated'', ''failed'')),
       payload_version smallint NOT NULL DEFAULT 1 CHECK (payload_version > 0),
       header_payload jsonb NOT NULL
         CHECK (jsonb_typeof(header_payload) = ''object''),
       items_payload jsonb NOT NULL
         CHECK (CASE
           WHEN jsonb_typeof(items_payload) = ''array''
             THEN jsonb_array_length(items_payload) > 0
           ELSE false
         END),
       document_path text,
       created_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
       created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
       available_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
       attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
       locked_by text,
       locked_until timestamptz,
       processed_at timestamptz,
       replicated_at timestamptz,
       local_purchase_id bigint,
       last_error text,
       CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
       CHECK (status <> ''processing'' OR locked_by IS NOT NULL),
       CHECK (status NOT IN (''local_processed'', ''replicated'') OR processed_at IS NOT NULL),
       CHECK (status <> ''replicated'' OR replicated_at IS NOT NULL)
     )',
    p_schema_name
  );

  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS purchase_import_jobs_claim_idx
       ON %I.purchase_import_jobs (available_at, created_at, id)
       WHERE status IN (''pending'', ''processing'')',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'CREATE UNIQUE INDEX IF NOT EXISTS purchase_import_jobs_single_processing_uidx
       ON %I.purchase_import_jobs ((status))
       WHERE status = ''processing''',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS purchase_import_jobs_creator_idx
       ON %I.purchase_import_jobs (created_by, created_at DESC)',
    p_schema_name
  );

  SELECT EXISTS (
    SELECT 1 FROM public.profile_table_permissions AS permission
    WHERE permission.schema_name = p_schema_name
      AND permission.table_name = 'purchase_import_jobs'
  ) INTO v_has_queue_permissions;

  -- Reuse the established schema-wide RLS and grants, then specialize this
  -- queue so authenticated clients can enqueue but only worker RPCs advance it.
  PERFORM private.provision_branch_schema(p_schema_name);

  EXECUTE pg_catalog.format(
    'DROP POLICY IF EXISTS access_profile_select ON %I.purchase_import_jobs',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY access_profile_select ON %I.purchase_import_jobs
       FOR SELECT TO authenticated
       USING (
         (SELECT private.has_table_access(%L, ''purchase_import_jobs'', ''select''))
         OR (SELECT private.is_purchase_import_worker(%L))
       )',
    p_schema_name, p_schema_name, p_schema_name
  );

  EXECUTE pg_catalog.format(
    'DROP POLICY IF EXISTS access_profile_insert ON %I.purchase_import_jobs',
    p_schema_name
  );

  EXECUTE pg_catalog.format(
    'REVOKE INSERT, UPDATE, DELETE ON TABLE %I.purchase_import_jobs FROM PUBLIC, anon, authenticated, service_role',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'GRANT SELECT ON TABLE %I.purchase_import_jobs TO authenticated',
    p_schema_name
  );

  IF NOT v_has_queue_permissions THEN
    UPDATE public.profile_table_permissions AS permission
    SET can_select = CASE permission.profile_key
          WHEN 'admin' THEN true
          WHEN 'almacen' THEN true
          ELSE false
        END,
        can_insert = permission.profile_key IN ('admin', 'almacen'),
        can_update = false,
        can_delete = false,
        updated_at = pg_catalog.now()
    WHERE permission.schema_name = p_schema_name
      AND permission.table_name = 'purchase_import_jobs'
      AND permission.profile_key IN ('admin', 'gerencia', 'almacen');
  END IF;

  IF pg_catalog.to_regclass(pg_catalog.format('%I.inv_estatus_compras', p_schema_name)) IS NULL THEN
    RAISE EXCEPTION 'Falta %.inv_estatus_compras para procesar compras.', p_schema_name
      USING ERRCODE = '42P01';
  END IF;

  EXECUTE pg_catalog.format(
    'INSERT INTO %I.inv_estatus_compras (id, estado)
     VALUES
       (1, ''PAGADO''),
       (2, ''PENDIENTE DE PAGO''),
       (5, ''RECIBIDA''),
       (6, ''PENDIENTE DE RECEPCI'' || pg_catalog.chr(211) || ''N'')
     ON CONFLICT (id) DO NOTHING',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'SELECT pg_catalog.count(*)::integer
     FROM %I.inv_estatus_compras
     WHERE (id, estado) IN (
       (1, ''PAGADO''),
       (2, ''PENDIENTE DE PAGO''),
       (5, ''RECIBIDA''),
       (6, ''PENDIENTE DE RECEPCI'' || pg_catalog.chr(211) || ''N'')
     )',
    p_schema_name
  ) INTO v_status_count;
  IF v_status_count <> 4 THEN
    RAISE EXCEPTION 'Los estados de compra 1, 2, 5 y 6 deben conservar sus valores acordados en %.inv_estatus_compras.', p_schema_name
      USING ERRCODE = '23514';
  END IF;

  EXECUTE 'SELECT pg_catalog.pg_get_serial_sequence($1, $2)'
    INTO v_status_sequence
    USING pg_catalog.format('%I.%I', p_schema_name, 'inv_estatus_compras'), 'id';
  IF v_status_sequence IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'SELECT pg_catalog.max(id)::bigint FROM %I.inv_estatus_compras',
      p_schema_name
    ) INTO v_status_max_id;
    EXECUTE pg_catalog.format(
      'SELECT last_value, is_called FROM %s',
      v_status_sequence::regclass
    ) INTO v_status_sequence_last_value, v_status_sequence_is_called;
    IF NOT v_status_sequence_is_called OR v_status_sequence_last_value < v_status_max_id THEN
      PERFORM pg_catalog.setval(v_status_sequence::regclass, v_status_max_id, true);
    END IF;
  END IF;

  EXECUTE pg_catalog.format($wrapper$
    CREATE OR REPLACE FUNCTION %I.enqueue_purchase_import_job(
      p_job_id uuid,
      p_header_payload jsonb,
      p_items_payload jsonb,
      p_document_path text
    )
    RETURNS TABLE (id uuid, status text)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = ''
    AS $body$ SELECT * FROM private.enqueue_purchase_import_job(%L, p_job_id, p_header_payload, p_items_payload, p_document_path); $body$;
  $wrapper$, p_schema_name, p_schema_name);

  EXECUTE pg_catalog.format($wrapper$
    CREATE OR REPLACE FUNCTION %I.claim_purchase_import_job()
    RETURNS TABLE (
      id uuid,
      payload_version smallint,
      header_payload jsonb,
      items_payload jsonb,
      document_path text,
      attempt_count integer
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = ''
    AS $body$ SELECT * FROM private.claim_purchase_import_job(%L); $body$;
  $wrapper$, p_schema_name, p_schema_name);

  EXECUTE pg_catalog.format($wrapper$
    CREATE OR REPLACE FUNCTION %I.acknowledge_purchase_import_job(
      p_job_id uuid, p_local_purchase_id bigint
    )
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = ''
    AS $body$ SELECT private.acknowledge_purchase_import_job(%L, p_job_id, p_local_purchase_id); $body$;
  $wrapper$, p_schema_name, p_schema_name);

  EXECUTE pg_catalog.format($wrapper$
    CREATE OR REPLACE FUNCTION %I.report_purchase_import_failure(
      p_job_id uuid, p_error text, p_retryable boolean
    )
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = ''
    AS $body$ SELECT private.report_purchase_import_failure(%L, p_job_id, p_error, p_retryable); $body$;
  $wrapper$, p_schema_name, p_schema_name);

  EXECUTE pg_catalog.format($wrapper$
    CREATE OR REPLACE FUNCTION %I.mark_purchase_import_replicated(p_job_id uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = ''
    AS $body$ SELECT private.mark_purchase_import_replicated(%L, p_job_id); $body$;
  $wrapper$, p_schema_name, p_schema_name);

  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.enqueue_purchase_import_job(uuid, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.claim_purchase_import_job() FROM PUBLIC, anon, authenticated, service_role',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.acknowledge_purchase_import_job(uuid, bigint) FROM PUBLIC, anon, authenticated, service_role',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.report_purchase_import_failure(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.mark_purchase_import_replicated(uuid) FROM PUBLIC, anon, authenticated, service_role',
    p_schema_name
  );
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %I.enqueue_purchase_import_job(uuid, jsonb, jsonb, text),
       %I.claim_purchase_import_job(),
       %I.acknowledge_purchase_import_job(uuid, bigint),
       %I.report_purchase_import_failure(uuid, text, boolean),
       %I.mark_purchase_import_replicated(uuid) TO authenticated',
    p_schema_name, p_schema_name, p_schema_name, p_schema_name, p_schema_name
  );
END;
$$;

REVOKE ALL ON FUNCTION private.provision_purchase_import_queue(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- The queue lives in each already-exposed branch schema. The private schema
-- remains unexposed; worker RPCs are available inside each branch schema.
DO $$
DECLARE
  v_schema record;
BEGIN
  FOR v_schema IN
    SELECT branch.schema_name::text AS schema_name
    FROM public.empresas_esquemas AS branch
    ORDER BY branch.schema_name
  LOOP
    PERFORM private.provision_purchase_import_queue(v_schema.schema_name);
  END LOOP;
END;
$$;

INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
VALUES (
  'purchase-documents',
  'purchase-documents',
  false,
  52428800,
  ARRAY['image/png', 'image/jpeg', 'application/pdf', 'application/xml', 'text/xml']::text[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS purchase_import_documents_read ON storage.objects;
CREATE POLICY purchase_import_documents_read
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'purchase-documents'
    AND (
      (SELECT private.has_table_access(
        (storage.foldername(name))[1], 'purchase_import_jobs', 'select'
      ))
      OR (SELECT private.is_purchase_import_worker((storage.foldername(name))[1]))
    )
  );

DROP POLICY IF EXISTS purchase_import_documents_upload ON storage.objects;
CREATE POLICY purchase_import_documents_upload
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'purchase-documents'
    AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)
    AND (SELECT private.has_table_access(
      (storage.foldername(name))[1], 'purchase_import_jobs', 'insert'
    ))
  );

DROP POLICY IF EXISTS purchase_import_documents_cleanup ON storage.objects;
CREATE POLICY purchase_import_documents_cleanup
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'purchase-documents'
    AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)
    AND (SELECT private.has_table_access(
      (storage.foldername(name))[1], 'purchase_import_jobs', 'insert'
    ))
  );
