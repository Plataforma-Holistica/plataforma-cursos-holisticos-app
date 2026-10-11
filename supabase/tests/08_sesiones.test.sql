-- T-104 · Las sesiones que la aplicación reconoce (RF-102, RNF-08). TRD §9.2, esquema §5.1 y §6.2.
-- La guarda solo deja pasar una sesión que el servidor anotó y que sigue viva en Auth. Y una
-- sesión solo se anota si su intento empezó después del último cambio de contraseña.
begin;
\ir _ayuda.psql
select plan(66);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'alumna-sesiones@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'otra-sesiones@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'suspendida-sesiones@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000004', 'pendiente-sesiones@prueba.test');
select pruebas.confirmar(id) from public.profiles where id::text like 'a0000000-0000-0000-0000-00000000000_';

-- Sesiones como las abre Supabase Auth. La cuarta ya venció por su fecha tope.
insert into auth.sessions (id, user_id, created_at, updated_at, not_after) values
  ('5e550000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', now(), now(), null),
  ('5e550000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', now(), now(), null),
  ('5e550000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', now(), now(), null),
  ('5e550000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', now(), now(), now() - interval '1 minute'),
  ('5e550000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000003', now(), now(), null),
  ('5e550000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000004', now(), now(), null),
  ('5e550000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', now(), now(), now() + interval '1 day');

-- ---------------------------------------------------------------------------------------
-- Estructura: dos tablas privadas que nadie toca directo, ni el servidor.

select is(
  (select array_agg(c.relname::text order by c.relname)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private' and c.relname in ('app_sessions', 'account_security') and c.relrowsecurity),
  array['account_security', 'app_sessions'],
  'las dos tablas existen y tienen seguridad por fila');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'private' and tablename in ('app_sessions', 'account_security')),
  0, 'ninguna tiene políticas');
select ok(
  not has_table_privilege(r, 'private.' || t, 'select, insert, update, delete, truncate')
    and not has_any_column_privilege(r, 'private.' || t, 'select, insert, update'),
  r || ' no tiene ningún permiso sobre ' || t)
from unnest(array['app_sessions', 'account_security']) as t,
     unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;
select ok(
  has_function_privilege('app_service', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute')
    and not has_function_privilege('anon', f, 'execute')
    and not has_function_privilege('service_role', f, 'execute'),
  'solo el servidor ejecuta ' || f)
from unnest(array['private.note_session(uuid, timestamptz)', 'private.session_recognized(uuid)']) as f;
select is_empty(
  'select * from private.schema_violations()',
  'private.schema_violations() sigue en cero');

-- Lo que las funciones leen de Supabase Auth. Si una versión nueva lo cambia, se nota aquí.
select has_column('auth', 'sessions', c, 'auth.sessions conserva la columna ' || c)
from unnest(array['id', 'user_id', 'not_after']) as c;

-- ---------------------------------------------------------------------------------------
-- Anotar una sesión: cada condición, por separado.

select pruebas.como_servicio();
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'ineligible', 'sin actor declarado no se anota nada');
select pruebas.como_sistema();
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'ineligible', 'el sistema no anota sesiones');

select pruebas.como_servicio('a0000000-0000-0000-0000-0000000000ee');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'ineligible', 'un actor sin perfil no anota nada');

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'unclaimed', 'con la marca de contraseña prendida no se anota');
select is(private.claim_account(), 'claimed', 'la cuenta se reclama');

select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', now()),
  'stale', 'un intento que empezó antes del cambio de contraseña no se anota');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp() - interval '130 seconds'),
  'stale', 'y si además tardó de más, manda lo primero: la contraseña ya no vale');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp() + interval '1 second'),
  'skewed', 'uno que dice haber empezado en el futuro tampoco, y se distingue: el reloj no es de fiar');
select is(
  private.note_session(null, clock_timestamp()),
  'ineligible', 'sin identificador de sesión no se anota');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', null),
  'ineligible', 'sin hora de inicio tampoco');
select is(
  private.note_session('5e550000-0000-0000-0000-0000000000ff', clock_timestamp()),
  'gone', 'una sesión que Auth no tiene no se anota');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000003', clock_timestamp()),
  'gone', 'ni la sesión de otra cuenta');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000004', clock_timestamp()),
  'gone', 'ni una que ya pasó su fecha tope');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'noted', 'una sesión propia, viva y empezada después del cambio, se anota');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'noted', 'anotarla dos veces no falla');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000007', clock_timestamp()),
  'noted', 'una con fecha tope futura también se anota');

-- Un intento que tardó más de lo que tarda cualquier llamada a Auth no se anota. Para
-- probarlo se atrasa el cambio de contraseña, como dueño.
select pruebas.como_dueno();
update private.account_security set password_changed_at = now() - interval '10 minutes'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000002', clock_timestamp() - interval '130 seconds'),
  'skewed', 'un intento de hace más de dos minutos no se anota, aunque sea posterior al cambio');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000002', clock_timestamp() - interval '110 seconds'),
  'noted', 'uno de hace menos de dos minutos sí');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000002', clock_timestamp()),
  'noted', 'y uno de ahora también');

-- Una cuenta con la marca apagada pero sin fecha de reclamo: no se sabe desde cuándo vale
-- su contraseña.
select pruebas.como_dueno();
insert into private.account_security (profile_id, password_changed_at)
  values ('a0000000-0000-0000-0000-000000000004', now() - interval '1 hour');
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000004');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000006', clock_timestamp()),
  'unclaimed', 'con la marca prendida no se anota, aunque la cuenta ya tenga fecha');
select is(private.claim_account(), 'claimed', 'otra cuenta se reclama');
select pruebas.como_dueno();
delete from private.account_security where profile_id = 'a0000000-0000-0000-0000-000000000004';
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000004');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000006', clock_timestamp()),
  'unclaimed', 'sin fecha de reclamo no se anota, aunque la marca esté apagada');

-- Una cuenta que no está activa: eliminada o suspendida.
select pruebas.como_dueno();
select set_config('app.actor_kind', 'system', true);
update public.profiles set status = 'deleted', deleted_at = now()
  where id = 'a0000000-0000-0000-0000-000000000004';
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000004');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000006', clock_timestamp()),
  'ineligible', 'una cuenta eliminada no anota sesiones');

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000003');
select is(private.claim_account(), 'claimed', 'la tercera cuenta se reclama');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000005', clock_timestamp()),
  'noted', 'y anota una sesión mientras está activa');
select pruebas.como_dueno();
select set_config('app.actor_kind', 'system', true);
update public.profiles set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba'
  where id = 'a0000000-0000-0000-0000-000000000003';
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000003');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000005', clock_timestamp()),
  'ineligible', 'una cuenta suspendida no anota sesiones');

-- ---------------------------------------------------------------------------------------
-- Reconocer una sesión.

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000001'),
  'recognized', 'una sesión anotada y viva se reconoce');
select is(
  private.session_recognized(null),
  'unknown', 'sin identificador de sesión no se reconoce nada');
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000002');
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000003'),
  'not_noted', 'una sesión viva en Auth que el servidor no anotó no se reconoce');
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000001'),
  'not_noted', 'ni la sesión anotada de otra persona');

-- Una fila que no debería existir: anotada para una cuenta, con la sesión de otra en Auth.
-- Solo el dueño puede escribirla; aun así no se reconoce.
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id)
  values ('5e550000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001');
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000003'),
  'gone', 'una sesión anotada a nombre de una cuenta, pero que en Auth es de otra, no se reconoce');
select pruebas.como_dueno();
delete from private.app_sessions where session_id = '5e550000-0000-0000-0000-000000000003';
-- Y algo anotado de la otra cuenta cuya sesión Auth ya no tiene: nadie más debe borrarlo.
insert into private.app_sessions (session_id, profile_id)
  values ('5e550000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000002');

select pruebas.como_servicio();
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000001'),
  'unknown', 'sin actor declarado no se reconoce nada');

-- La sesión se cierra en Auth (salir, cambio de contraseña): deja de reconocerse sola.
select pruebas.como_dueno();
delete from auth.sessions where id = '5e550000-0000-0000-0000-000000000002';
update auth.sessions set not_after = now() - interval '1 second'
  where id = '5e550000-0000-0000-0000-000000000007';
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000002'),
  'gone', 'una sesión anotada que Auth ya borró no se reconoce');
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000007'),
  'gone', 'ni una que pasó su fecha tope');

-- Anotar otra limpia las filas de las que ya no existen.
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'noted', 'se anota de nuevo');
select pruebas.como_dueno();
select results_eq(
  $$select session_id::text from private.app_sessions
    where profile_id = 'a0000000-0000-0000-0000-000000000001' order by session_id$$,
  array['5e550000-0000-0000-0000-000000000001', '5e550000-0000-0000-0000-000000000007'],
  'al anotar se borra la fila de la sesión que Auth ya no tiene, y no las demás');
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'a0000000-0000-0000-0000-000000000002'),
  1, 'y no se limpia lo anotado de otra cuenta');

-- ---------------------------------------------------------------------------------------
-- Reclamar otra vez (recuperar la contraseña) borra lo anotado y mueve la fecha.

select password_changed_at as antes from private.account_security
  where profile_id = 'a0000000-0000-0000-0000-000000000001' \gset
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(private.claim_account(), 'already_claimed', 'reclamar una cuenta ya reclamada contesta lo de siempre');
select is(
  private.session_recognized('5e550000-0000-0000-0000-000000000001'),
  'not_noted', 'pero la sesión anotada antes deja de reconocerse');
select pruebas.como_dueno();
select ok(
  (select password_changed_at > :'antes'::timestamptz from private.account_security
   where profile_id = 'a0000000-0000-0000-0000-000000000001'),
  'y la fecha del cambio de contraseña avanzó');
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'a0000000-0000-0000-0000-000000000002'),
  1, 'sin tocar lo anotado de otra cuenta');

-- Una cuenta que no puede reclamarse también pierde lo anotado y cambia de fecha: si
-- alguien fijó su contraseña, lo de antes ya no vale.
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000003');
select is(private.claim_account(), 'ineligible', 'la cuenta suspendida no se reclama');
select pruebas.como_dueno();
select ok(
  (select password_changed_at = (select max(password_changed_at) from private.account_security)
   from private.account_security where profile_id = 'a0000000-0000-0000-0000-000000000003'),
  'pero su fecha de cambio sí se mueve');
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'a0000000-0000-0000-0000-000000000003'),
  0, 'y lo que tenía anotado se borra');

-- ---------------------------------------------------------------------------------------
-- Nadie más llama a las funciones ni toca las tablas.

select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$select private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp())$$,
  '42501', null, 'una persona no anota sesiones con su sesión');
select throws_ok(
  $$select private.session_recognized('5e550000-0000-0000-0000-000000000001')$$,
  '42501', null, 'ni pregunta si una se reconoce');
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into private.app_sessions (session_id, profile_id)
    values ('5e550000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001')$$,
  '42501', null, 'el servidor no anota una sesión escribiendo la tabla');
select throws_ok(
  $$update private.account_security set password_changed_at = now() - interval '1 year'$$,
  '42501', null, 'ni mueve la fecha del cambio de contraseña');

-- Borrar la cuenta se lleva lo suyo.
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(
  private.note_session('5e550000-0000-0000-0000-000000000001', clock_timestamp()),
  'noted', 'se anota una última vez');
select pruebas.como_dueno();
delete from public.profiles where id = 'a0000000-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'a0000000-0000-0000-0000-000000000001')
    + (select count(*)::int from private.account_security where profile_id = 'a0000000-0000-0000-0000-000000000001'),
  0, 'al borrar un perfil se van sus sesiones anotadas y su fecha');

select pruebas.limpiar();
select * from finish();
rollback;
