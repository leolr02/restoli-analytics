# Control de acceso por perfil y sucursal

Las migraciones están separadas en dos fases para no cortar las sesiones ni
los permisos existentes antes de identificar a los usuarios y revisar los 23
accesos de escritura actuales de `coyote_azul_riviera`.

## Fase 1: estructura y administración

`20261111051549_user_profiles_branch_permissions_rls.sql` agrega el modelo de
perfiles, asignaciones de sucursal, matriz CRUD por perfil y las funciones de
administración protegidas por root. No habilita RLS ni revoca permisos en las
tablas operativas existentes.

Después de aplicar esta migración, registrar manualmente en Supabase Auth la
cuenta que será root. Desde el SQL Editor, inicializarla con su UUID de Auth:

```sql
select private.bootstrap_root('<UUID de Auth>');
```

La función no está disponible desde la API. La cuenta root puede asignar
perfiles y sucursales desde `/protected/access`. Si se requiere transferir root,
la operación se hace de forma administrativa con
`select private.transfer_root('<UUID de Auth>');`.

## Fase 2: corte de acceso

`20261111052708_enforce_branch_row_level_security.sql` habilita RLS en las
tablas registradas de ambas sucursales, limita el catálogo público de
sucursales y retira las concesiones `anon`/`authenticated` existentes. Los
usuarios que no tengan perfil y sucursal asignados quedan sin acceso.

Antes de aplicarla al proyecto remoto:

1. Aplicar la fase 1 y registrar el único root.
2. Auditar los clientes que dependen de las escrituras actuales en
   `coyote_azul_riviera`.
3. Asignar perfiles y sucursales a cada usuario Auth que deba conservar acceso.
4. Confirmar el mapa final de permisos con root y ejecutar la fase 2 en una
   ventana controlada.

El perfil `admin` parte con CRUD en las tablas de sus sucursales asignadas;
`gerencia` parte sin permisos de tabla hasta que root los configure; `almacen`
parte con CRUD en las tres tablas de compras, lectura en catálogos de compra y
lectura en tablas de ventas. Root puede cambiar la matriz por esquema y tabla.

Para exponer el acceso por la Data API, mantener únicamente los esquemas
necesarios en la configuración de API de Supabase. El archivo `config.toml`
configura los dos esquemas de sucursal para el entorno local; la configuración
del proyecto remoto se administra aparte en el Dashboard.

## Nuevos esquemas o tablas

El alta física de un esquema sigue siendo una operación administrativa de base
de datos. Después de registrarlo en `public.empresas_esquemas` y crear sus
tablas, un operador de base de datos debe ejecutar
`select private.provision_purchase_import_queue('<schema>');`. Esta función
crea la cola `purchase_import_jobs` dentro del esquema, configura sus RPC y
ejecuta el aprovisionamiento de RLS y permisos del esquema. La aplicación no
acepta nombres de esquema o tabla arbitrarios para generar SQL.

## Cola de compras para procesamiento local

La aplicación guarda solicitudes pendientes en una tabla `purchase_import_jobs`
independiente dentro de cada esquema de sucursal. La compra canónica continúa
originándose en la base local mediante `inv_fn_addbuy` y llega a las tablas
`inv_compras` e `inv_detalles_compras` de Supabase por el flujo WAL existente.
El consumidor de entrada y el sincronizador WAL son flujos separados.

El diseño del payload, el alta de consumidores autenticados y el contrato de
las funciones RPC se documentan en [`PURCHASE_IMPORT_QUEUE.md`](PURCHASE_IMPORT_QUEUE.md).

## Pruebas locales

Con Docker disponible, ejecutar `npx supabase start` y `npx supabase test db`.
Las pruebas crean sucursales temporales y verifican aislamiento entre ramas,
los cuatro perfiles y operaciones permitidas o denegadas.
