BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(30);

CREATE SCHEMA authorization_test_one;
CREATE SCHEMA authorization_test_two;
CREATE TABLE authorization_test_one.inv_compras (
  id integer PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE authorization_test_one.ventas (
  id integer PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE authorization_test_two.inv_compras (
  id integer PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE authorization_test_two.ventas (
  id integer PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO public.empresas_esquemas (schema_name)
VALUES ('authorization_test_one'), ('authorization_test_two');
SELECT private.provision_branch_schema('authorization_test_one');
SELECT private.provision_branch_schema('authorization_test_two');

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'root-test@example.invalid', 'test-only', now(), now(), now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-test@example.invalid', 'test-only', now(), now(), now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gerencia-test@example.invalid', 'test-only', now(), now(), now()),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'almacen-test@example.invalid', 'test-only', now(), now(), now()),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pending-test@example.invalid', 'test-only', now(), now(), now());

INSERT INTO public.user_access_profiles (user_id, profile_key)
VALUES
  ('10000000-0000-0000-0000-000000000001', 'root'),
  ('10000000-0000-0000-0000-000000000002', 'admin'),
  ('10000000-0000-0000-0000-000000000003', 'gerencia'),
  ('10000000-0000-0000-0000-000000000004', 'almacen');

INSERT INTO public.user_branch_access (user_id, schema_name)
VALUES
  ('10000000-0000-0000-0000-000000000002', 'authorization_test_one'),
  ('10000000-0000-0000-0000-000000000003', 'authorization_test_one'),
  ('10000000-0000-0000-0000-000000000004', 'authorization_test_one');

UPDATE public.profile_table_permissions
SET can_select = true
WHERE profile_key = 'gerencia'
  AND schema_name = 'authorization_test_one'
  AND table_name = 'inv_compras';

INSERT INTO authorization_test_one.inv_compras VALUES (1, 'compra-uno');
INSERT INTO authorization_test_one.ventas VALUES (1, 'venta-uno');
INSERT INTO authorization_test_two.inv_compras VALUES (2, 'compra-dos');
INSERT INTO authorization_test_two.ventas VALUES (2, 'venta-dos');

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'authorization_test_one.inv_compras'::regclass),
  'RLS está habilitado en compras'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'authorization_test_one.ventas'::regclass),
  'RLS está habilitado en ventas'
);
SELECT ok(
  NOT has_table_privilege('anon', 'authorization_test_one.inv_compras', 'SELECT'),
  'anon no recibe SELECT sobre las tablas de sucursal'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.empresas_esquemas', 'SELECT'),
  'anon no recibe SELECT sobre el catálogo de sucursales'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT results_eq(
  $$SELECT count(*)::bigint FROM authorization_test_one.inv_compras$$,
  $$VALUES (1::bigint)$$,
  'root lee compras en la primera sucursal'
);
SELECT results_eq(
  $$SELECT count(*)::bigint FROM authorization_test_two.ventas$$,
  $$VALUES (1::bigint)$$,
  'root lee ventas en la segunda sucursal'
);
SELECT lives_ok(
  $$INSERT INTO authorization_test_two.inv_compras VALUES (3, 'root')$$,
  'root puede escribir en cualquier sucursal'
);
SELECT throws_ok(
  $$SELECT public.root_set_user_profile('10000000-0000-0000-0000-000000000005', 'root')$$,
  '22023', NULL,
  'root no puede crear un segundo root desde la aplicación'
);

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
SELECT results_eq(
  $$SELECT count(*)::bigint FROM authorization_test_one.inv_compras$$,
  $$VALUES (1::bigint)$$,
  'gerencia lee una tabla habilitada por root'
);
SELECT results_eq(
  $$SELECT count(*)::bigint FROM authorization_test_two.inv_compras$$,
  $$VALUES (0::bigint)$$,
  'gerencia no lee sucursales no asignadas'
);
SELECT throws_ok(
  $$INSERT INTO authorization_test_one.inv_compras VALUES (4, 'gerencia')$$,
  '42501', NULL,
  'gerencia no puede insertar'
);
SELECT is(
  (WITH changed AS (
    UPDATE authorization_test_one.inv_compras SET value = 'bloqueada' WHERE id = 1 RETURNING id
  ) SELECT count(*)::integer FROM changed),
  0,
  'gerencia no puede actualizar'
);
SELECT is(
  (WITH changed AS (
    DELETE FROM authorization_test_one.inv_compras WHERE id = 1 RETURNING id
  ) SELECT count(*)::integer FROM changed),
  0,
  'gerencia no puede borrar'
);
SELECT results_eq(
  $$SELECT schema_name::text FROM public.empresas_esquemas$$,
  $$VALUES ('authorization_test_one'::text)$$,
  'gerencia solo ve su sucursal en el catálogo'
);

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000004', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO authorization_test_one.inv_compras VALUES (5, 'almacen')$$,
  'almacén puede insertar compras'
);
SELECT results_eq(
  $$SELECT count(*)::bigint FROM authorization_test_one.ventas$$,
  $$VALUES (1::bigint)$$,
  'almacén puede leer ventas'
);
SELECT throws_ok(
  $$INSERT INTO authorization_test_one.ventas VALUES (6, 'almacen')$$,
  '42501', NULL,
  'almacén no puede insertar ventas'
);
SELECT is(
  (WITH changed AS (
    UPDATE authorization_test_one.ventas SET value = 'bloqueada' WHERE id = 1 RETURNING id
  ) SELECT count(*)::integer FROM changed),
  0,
  'almacén no puede actualizar ventas'
);
SELECT is(
  (WITH changed AS (
    DELETE FROM authorization_test_one.ventas WHERE id = 1 RETURNING id
  ) SELECT count(*)::integer FROM changed),
  0,
  'almacén no puede borrar ventas'
);
SELECT lives_ok(
  $$UPDATE authorization_test_one.inv_compras SET value = 'almacen actualizado' WHERE id = 1$$,
  'almacén puede actualizar compras'
);
SELECT lives_ok(
  $$DELETE FROM authorization_test_one.inv_compras WHERE id = 5$$,
  'almacén puede borrar compras'
);

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO authorization_test_one.ventas VALUES (7, 'admin')$$,
  'admin puede modificar tablas de la sucursal asignada'
);
SELECT results_eq(
  $$SELECT count(*)::bigint FROM authorization_test_two.ventas$$,
  $$VALUES (0::bigint)$$,
  'admin no lee otra sucursal'
);
SELECT throws_ok(
  $$INSERT INTO authorization_test_two.ventas VALUES (8, 'admin')$$,
  '42501', NULL,
  'admin no puede escribir en otra sucursal'
);

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000005', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
SELECT results_eq(
  $$SELECT count(*)::bigint FROM authorization_test_one.inv_compras$$,
  $$VALUES (0::bigint)$$,
  'un usuario sin perfil no ve datos'
);
SELECT throws_ok(
  $$INSERT INTO authorization_test_one.inv_compras VALUES (9, 'sin perfil')$$,
  '42501', NULL,
  'un usuario sin perfil no puede escribir'
);

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT lives_ok(
  $$SELECT public.root_set_user_profile('10000000-0000-0000-0000-000000000005', 'gerencia')$$,
  'root puede asignar perfiles'
);
SELECT lives_ok(
  $$SELECT public.root_set_user_branches('10000000-0000-0000-0000-000000000005', ARRAY['authorization_test_two'])$$,
  'root puede asignar sucursales'
);
SELECT is(
  (SELECT count(*)::integer FROM public.user_branch_access
   WHERE user_id = '10000000-0000-0000-0000-000000000005'),
  1,
  'la asignación de sucursal se guardó'
);
SELECT is(
  (SELECT count(*)::integer FROM public.root_list_users()),
  5,
  'root puede consultar la lista de usuarios de Auth'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
