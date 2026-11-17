# Cola de importación de compras

## Flujo

Cada esquema de sucursal contiene su propia tabla `purchase_import_jobs`. La
aplicación web encola una compra mediante la RPC del esquema elegido. Una instancia Kotlin
autenticada, asociada a un solo esquema, reclama trabajos mediante las RPC de
ese esquema y ejecuta la lógica de compra local dentro de una transacción.

La tabla de cola no se replica por WAL. Tras procesar localmente una compra,
los cambios canónicos de `inv_compras`, `inv_detalles_compras` y las tablas de
inventario afectadas siguen el flujo WAL local → Supabase. El consumidor debe
confirmar la replicación solo después de que el sincronizador confirme ese
grupo de cambios.

## Aprovisionar una sucursal

Después de registrar el esquema en `public.empresas_esquemas` y crear sus
tablas de inventario, ejecutar desde SQL Editor:

```sql
select private.provision_purchase_import_queue('all_wings_select');
```

La función crea la cola, sus funciones RPC, las políticas RLS y las entradas de
permisos base. También garantiza los estados `1 PAGADO`, `2 PENDIENTE DE PAGO`,
`5 RECIBIDA` y `6 PENDIENTE DE RECEPCIÓN` en `inv_estatus_compras`; si esos IDs
ya existen con otros valores, la función falla para que se revise el catálogo
sin sobrescribirlo. El mismo procedimiento se usa para cada nuevo esquema.

Crear una cuenta de Auth exclusiva para el consumidor de cada sucursal y
asignarla desde SQL Editor. `user_id` es clave primaria, así que una cuenta de
consumidor solo se puede asociar a un esquema:

```sql
insert into public.purchase_import_workers (user_id, schema_name)
values ('<UUID_AUTH_DEL_CONSUMIDOR>', 'all_wings_select');
```

No usar la clave global `service_role` en el consumidor. La instancia inicia
sesión con la cuenta Auth asignada y solo puede reclamar trabajos del esquema
registrado para ese usuario.

## Datos de cada trabajo

`id` es el UUID idempotente de la solicitud. `header_payload` contiene:

- `ticket_number`, `invoice_number`
- `purchase_date` y `reception_date` en `yyyy-mm-dd`
- `supplier_id`, `payment_method` (`EFECTIVO` o `CREDITO`), `invoiced_status` (`A` o `P`)
- `advance`, `payment_days`, `received_by`, `other_expenses`, `notes`
- `subtotal`, `discount`, `taxes`, `total`, `document_name`

`items_payload` es un arreglo con `product_id`, `product_code`,
`product_barcode`, `product_name`, `line`, `department`, `brand`, `quantity`,
`unit`, `product_type`, `subtotal`, `discount`, `taxes` y `amount`. Los datos
descriptivos de producto se vuelven a verificar contra el catálogo activo al
encolar; la sucursal local debe usar el identificador para ejecutar su propia
lógica de inventario.

Los documentos se guardan en el bucket privado `purchase-documents`. El campo
`document_path` guarda la ruta `{schema}/{user_id}/{job_id}.{ext}`; los
consumidores descargan desde ese bucket y no deben construir URLs públicas.

## RPC por esquema

Las funciones están instaladas con el mismo nombre dentro de cada esquema y
requieren el JWT de la cuenta de consumidor:

- `enqueue_purchase_import_job(p_job_id, p_header_payload, p_items_payload,
  p_document_path)` la usa la API web con la sesión del usuario. Verifica el
  permiso de inserción, valida la estructura y los totales, y hace idempotente
  el UUID de solicitud. La matriz `can_insert` autoriza esta RPC; la tabla no
  permite inserciones directas desde REST.
- `claim_purchase_import_job()` reclama un trabajo pendiente o con lease vencido
  y devuelve `id`, `payload_version`, los dos payloads, `document_path` e
  `attempt_count`. La reserva dura treinta minutos; un bloqueo por esquema y un
  índice único evitan que dos consumidores procesen compras a la vez en esa
  sucursal. La función selecciona filas con `SKIP LOCKED`.
- `acknowledge_purchase_import_job(p_job_id, p_local_purchase_id)` marca la
  solicitud como `local_processed`. Es idempotente para el mismo ID local.
- `report_purchase_import_failure(p_job_id, p_error, p_retryable)` libera la
  reserva, reintenta con espera creciente hasta cinco intentos y después marca
  el trabajo `failed`.
- `mark_purchase_import_replicated(p_job_id)` marca `replicated` una vez que
  el sincronizador WAL confirmó los cambios canónicos correspondientes.

El historial de la aplicación llama a `public.get_purchase_import_history(p_page, p_search)`.
Esta función comprueba la sesión y selecciona únicamente esquemas donde el
usuario tenga `can_select` para `purchase_import_jobs` (root consulta todas las
sucursales). Devuelve un total global y una página ordenada de 100 registros,
incluyendo el nombre del proveedor desde el payload o desde el catálogo de la
sucursal para solicitudes anteriores. `p_search` busca en el encabezado,
productos y estado de las compras con la misma paginación. La aplicación
primero busca en páginas que ya cargó en el navegador y recurre a esta RPC
cuando no encuentra coincidencias locales.

El worker debe insertar en su base local un recibo con `job_id` único en la
misma transacción que invoca la función local de compra. Si la transacción local
ya contiene ese recibo, no debe volver a ejecutar la compra; debe responder con
el ID local previo y confirmar el trabajo. Cualquier resultado de
`inv_fn_addbuy` distinto de éxito debe provocar rollback, incluso si la función
devolvió el error como texto y no lanzó una excepción.

## Estados

`pending` → `processing` → `local_processed` → `replicated`. Un fallo que ya no
se reintentará deja el trabajo en `failed`. `local_processed` no equivale a
replicado: los campos `sincronizado` y `fecha_sincronizado` de las tablas
canónicas conservan su semántica actual.

## Límite de implementación

El repositorio Kotlin que consume WAL no está incluido en este workspace. La
migración y el contrato RPC quedan listos aquí; la implementación del recibo
local, la llamada a `inv_fn_addbuy` y la confirmación basada en el resultado
WAL requieren incorporar el repositorio Kotlin para mantener esas operaciones
atómicas con su código existente.
