-- T-104 · Las sesiones a la vista (RF-109). TRD §9.2, esquema §5.9 y §6.2; diseño, PA-25.
-- Una persona ve las sesiones que la aplicación le abrió y siguen vivas, cierra una y
-- cierra todas las demás. Ninguna función recibe de quién es la cuenta: es la de quien
-- actúa. Y la única manera de borrar una sesión de Auth desde el servidor son estas dos.
begin;
\ir _ayuda.psql
select plan(70);

select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'alumna-a-la-vista@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000002', 'otra-a-la-vista@prueba.test');
select pruebas.confirmar(id) from public.profiles where id::text like 'b0000000-0000-0000-0000-00000000000_';

-- Sesiones como las abre Supabase Auth, con su última actividad. De la primera cuenta:
-- tres anotadas y vivas, una anotada y vencida, una anotada que Auth ya no tiene (la 05, que
-- no se inserta aquí) y una abierta directo en Auth, sin anotar. De la segunda: dos anotadas.
insert into auth.sessions (id, user_id, created_at, updated_at, not_after) values
  ('5e560000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', now() - interval '3 days', now() - interval '1 minute', null),
  ('5e560000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', now() - interval '2 days', now() - interval '2 hours', null),
  ('5e560000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', now() - interval '1 day', now() - interval '5 hours', now() + interval '1 day'),
  ('5e560000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000001', now() - interval '9 days', now() - interval '8 days', now() - interval '1 minute'),
  ('5e560000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000001', now(), now(), null),
  ('5e560000-0000-0000-0000-000000000011', 'b0000000-0000-0000-0000-000000000002', now(), now(), null),
  ('5e560000-0000-0000-0000-000000000012', 'b0000000-0000-0000-0000-000000000002', now(), now() - interval '1 hour', null);

-- Lo anotado, puesto como dueño: cómo se anota una sesión ya lo prueba 08_sesiones.
insert into private.app_sessions (session_id, profile_id, opened_at) values
  ('5e560000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', now() - interval '3 days'),
  ('5e560000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', now() - interval '2 days'),
  ('5e560000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', now() - interval '1 day'),
  ('5e560000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000001', now() - interval '9 days'),
  ('5e560000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000001', now() - interval '4 days'),
  ('5e560000-0000-0000-0000-000000000011', 'b0000000-0000-0000-0000-000000000002', now()),
  ('5e560000-0000-0000-0000-000000000012', 'b0000000-0000-0000-0000-000000000002', now());

-- ---------------------------------------------------------------------------------------
-- Estructura.

select has_column('private', 'app_sessions', 'user_agent', 'cada sesión anotada puede llevar el navegador desde el que se abrió');
select col_type_is('private', 'app_sessions', 'user_agent', 'text', 'como texto');
select col_is_null('private', 'app_sessions', 'user_agent', 'y puede faltar: nadie está obligado a decirlo');
select ok(
  not has_table_privilege(r, 'private.app_sessions', 'select, insert, update, delete, truncate')
    and not has_any_column_privilege(r, 'private.app_sessions', 'select, insert, update'),
  r || ' sigue sin ningún permiso sobre app_sessions')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;
select ok(
  has_function_privilege('app_service', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute')
    and not has_function_privilege('anon', f, 'execute')
    and not has_function_privilege('service_role', f, 'execute'),
  'solo el servidor ejecuta ' || f)
from unnest(array[
  'private.tag_session(uuid, text)',
  'private.list_sessions()',
  'private.close_session(uuid)',
  'private.close_other_sessions(uuid)']) as f;
select ok(
  not has_table_privilege('app_service', 'auth.sessions', 'select, insert, update, delete, truncate'),
  'el servidor no toca auth.sessions por su cuenta: solo a través de estas funciones');
select is_empty(
  'select * from private.schema_violations()',
  'private.schema_violations() sigue en cero');

-- Lo que las funciones usan de Supabase Auth. Si una versión nueva lo cambia, se nota aquí.
select has_column('auth', 'sessions', c, 'auth.sessions conserva la columna ' || c)
from unnest(array['id', 'user_id', 'not_after', 'updated_at']) as c;
select is(
  (select confdeltype::text from pg_constraint
   where conrelid = 'auth.refresh_tokens'::regclass and confrelid = 'auth.sessions'::regclass and contype = 'f'),
  'c', 'borrar una sesión de Auth se lleva sus tokens de renovación: con ella deja de poder renovarse');

-- ---------------------------------------------------------------------------------------
-- Etiquetar una sesión con el navegador desde el que se abrió.

select pruebas.como_servicio();
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000001', 'Navegador A'),
  'ineligible', 'sin actor declarado no se etiqueta nada');
select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select is(
  private.tag_session(null, 'Navegador A'),
  'ineligible', 'ni sin decir cuál sesión');
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000011', 'Navegador A'),
  'not_noted', 'la sesión anotada de otra persona no se etiqueta');
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000006', 'Navegador A'),
  'not_noted', 'ni una propia que la aplicación no anotó');
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000001', ''),
  'kept', 'un navegador vacío no es una etiqueta');
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000001', null),
  'kept', 'ni uno que no se dijo');
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000001', 'Navegador A'),
  'tagged', 'la sesión propia y anotada queda etiquetada');
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000001', 'Navegador B'),
  'kept', 'la etiqueta no se cambia después: es de cuando se abrió');
select is(
  private.tag_session('5e560000-0000-0000-0000-000000000002', repeat('x', 600)),
  'tagged', 'un navegador desmedido también se guarda');
select pruebas.como_dueno();
select is(
  (select user_agent from private.app_sessions where session_id = '5e560000-0000-0000-0000-000000000001'),
  'Navegador A', 'con lo que se dijo la primera vez');
select is(
  (select char_length(user_agent) from private.app_sessions where session_id = '5e560000-0000-0000-0000-000000000002'),
  512, 'recortado a su largo fijo');
select is(
  (select count(*)::int from private.app_sessions
   where profile_id = 'b0000000-0000-0000-0000-000000000002' and user_agent is not null),
  0, 'y nada de la otra cuenta quedó etiquetado');
select throws_ok(
  $$update private.app_sessions set user_agent = repeat('x', 513) where session_id = '5e560000-0000-0000-0000-000000000003'$$,
  '23514', null, 'la tabla tampoco acepta uno más largo, ni del dueño');

-- ---------------------------------------------------------------------------------------
-- Ver las sesiones abiertas.

select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select results_eq(
  $$select session_id::text, user_agent is not null from private.list_sessions()$$,
  $$values ('5e560000-0000-0000-0000-000000000001', true),
           ('5e560000-0000-0000-0000-000000000002', true),
           ('5e560000-0000-0000-0000-000000000003', false)$$,
  'las anotadas y vivas de quien actúa, la más reciente primero: ni la vencida, ni la que Auth ya no tiene, ni la que nadie anotó, ni las de otra cuenta');
-- Lo que el servidor recibe se guarda aparte, y se compara como dueño: él no lee esas tablas.
select opened_at as abierta, last_active_at as actividad
from private.list_sessions() where session_id = '5e560000-0000-0000-0000-000000000002' \gset
select pruebas.como_dueno();
select is(
  :'abierta'::timestamptz = (select x.opened_at from private.app_sessions x where x.session_id = '5e560000-0000-0000-0000-000000000002')
    and :'actividad'::timestamptz = (select a.updated_at from auth.sessions a where a.id = '5e560000-0000-0000-0000-000000000002'),
  true, 'cada una con cuándo se abrió, según la aplicación, y su última actividad, según Auth');
select pruebas.como_servicio('b0000000-0000-0000-0000-000000000002');
select results_eq(
  $$select session_id::text from private.list_sessions()$$,
  array['5e560000-0000-0000-0000-000000000011', '5e560000-0000-0000-0000-000000000012'],
  'la otra cuenta ve las suyas y nada más');
select pruebas.como_servicio();
select is_empty(
  $$select * from private.list_sessions()$$,
  'sin actor declarado no se ve ninguna');

-- Una fila que no debería existir: anotada para una cuenta, con la sesión de otra en Auth.
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id)
  values ('5e560000-0000-0000-0000-000000000012', 'b0000000-0000-0000-0000-000000000001')
  on conflict (session_id) do update set profile_id = excluded.profile_id;
select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from private.list_sessions() where session_id = '5e560000-0000-0000-0000-000000000012'),
  0, 'una sesión anotada a nombre de una cuenta, pero que en Auth es de otra, no se lista');

-- ---------------------------------------------------------------------------------------
-- Cerrar una sesión.

select pruebas.como_servicio();
select is(
  private.close_session('5e560000-0000-0000-0000-000000000002'),
  'ineligible', 'sin actor declarado no se cierra nada');
select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select is(
  private.close_session(null),
  'ineligible', 'ni sin decir cuál');
select is(
  private.close_session('5e560000-0000-0000-0000-000000000011'),
  'not_found', 'la sesión de otra persona no se encuentra');
select is(
  private.close_session('5e560000-0000-0000-0000-0000000000ff'),
  'not_found', 'ni una que no existe');
-- La fila que no debería existir: se va lo anotado a nombre de quien actúa, y nada más.
select is(
  private.close_session('5e560000-0000-0000-0000-000000000012'),
  'closed', 'lo anotado a nombre propio se puede quitar');
select pruebas.como_dueno();
select is(
  (select count(*)::int from auth.sessions where id in
    ('5e560000-0000-0000-0000-000000000011', '5e560000-0000-0000-0000-000000000012')),
  2, 'pero las sesiones de la otra cuenta siguen vivas en Auth, también la que estaba mal anotada');
select is(
  (select count(*)::int from private.app_sessions where session_id = '5e560000-0000-0000-0000-000000000011'),
  1, 'y lo que la otra cuenta tiene anotado, intacto');

select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select is(
  private.close_session('5e560000-0000-0000-0000-000000000002'),
  'closed', 'la sesión propia se cierra');
select is(
  private.session_recognized('5e560000-0000-0000-0000-000000000002'),
  'not_noted', 'y la guarda deja de reconocerla en el acto');
select is(
  private.close_session('5e560000-0000-0000-0000-000000000002'),
  'not_found', 'cerrarla otra vez ya no encuentra nada');
select is(
  private.close_session('5e560000-0000-0000-0000-000000000005'),
  'closed', 'una anotada que Auth ya no tiene se limpia');
select is(
  private.close_session('5e560000-0000-0000-0000-000000000006'),
  'closed', 'y una propia abierta directo en Auth también se puede cerrar');
select pruebas.como_dueno();
select is(
  (select count(*)::int from auth.sessions where id in
    ('5e560000-0000-0000-0000-000000000002', '5e560000-0000-0000-0000-000000000006')),
  0, 'en Auth ya no existen');
select is(
  (select count(*)::int from private.app_sessions where session_id in
    ('5e560000-0000-0000-0000-000000000002', '5e560000-0000-0000-0000-000000000005')),
  0, 'ni quedan anotadas');
select results_eq(
  $$select id::text from auth.sessions where user_id = 'b0000000-0000-0000-0000-000000000001' order by id$$,
  array['5e560000-0000-0000-0000-000000000001', '5e560000-0000-0000-0000-000000000003', '5e560000-0000-0000-0000-000000000004'],
  'las demás sesiones de la cuenta siguen como estaban');

-- ---------------------------------------------------------------------------------------
-- Cerrar todas las demás.

-- Otra abierta directo en Auth, para ver que también se va.
insert into auth.sessions (id, user_id, created_at, updated_at, not_after) values
  ('5e560000-0000-0000-0000-000000000007', 'b0000000-0000-0000-0000-000000000001', now(), now(), null);

select pruebas.como_servicio();
select is(
  private.close_other_sessions('5e560000-0000-0000-0000-000000000001'),
  null, 'sin actor declarado no se cierra nada');
select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select is(
  private.close_other_sessions(null),
  null, 'sin decir cuál se queda, tampoco');
select is(
  private.close_other_sessions('5e560000-0000-0000-0000-000000000011'),
  null, 'ni quedándose con la sesión de otra persona');
select is(
  private.close_other_sessions('5e560000-0000-0000-0000-000000000007'),
  null, 'ni con una propia que la aplicación no anotó');
select is(
  private.close_other_sessions('5e560000-0000-0000-0000-000000000004'),
  null, 'ni con una anotada que ya venció');
select pruebas.como_dueno();
select is(
  (select count(*)::int from auth.sessions where user_id = 'b0000000-0000-0000-0000-000000000001'),
  4, 'ninguna de esas negativas cerró nada');

select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select is(
  private.close_other_sessions('5e560000-0000-0000-0000-000000000001'),
  3, 'con la sesión propia, anotada y viva: dice cuántas cerró en Auth');
select pruebas.como_dueno();
select results_eq(
  $$select id::text from auth.sessions where user_id = 'b0000000-0000-0000-0000-000000000001'$$,
  array['5e560000-0000-0000-0000-000000000001'],
  'en Auth solo queda esa: se fueron la vencida y la que nadie había anotado');
select results_eq(
  $$select session_id::text from private.app_sessions where profile_id = 'b0000000-0000-0000-0000-000000000001'$$,
  array['5e560000-0000-0000-0000-000000000001'],
  'y anotada, solo esa');
select is(
  (select count(*)::int from auth.sessions where user_id = 'b0000000-0000-0000-0000-000000000002')
    + (select count(*)::int from private.app_sessions where profile_id = 'b0000000-0000-0000-0000-000000000002'),
  3, 'la otra cuenta conserva sus dos sesiones y lo que tiene anotado');
select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select is(
  private.session_recognized('5e560000-0000-0000-0000-000000000001'),
  'recognized', 'la que se quedó se sigue reconociendo');
select is(
  private.close_other_sessions('5e560000-0000-0000-0000-000000000001'),
  0, 'sin otras que cerrar, cierra cero');

-- ---------------------------------------------------------------------------------------
-- Nadie más llama a las funciones ni toca las tablas.

select pruebas.como_usuario('b0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$select private.tag_session('5e560000-0000-0000-0000-000000000001', 'x')$$,
  '42501', null, 'una persona no etiqueta sesiones con su sesión');
select throws_ok(
  $$select * from private.list_sessions()$$,
  '42501', null, 'ni las lista por su cuenta');
select throws_ok(
  $$select private.close_session('5e560000-0000-0000-0000-000000000001')$$,
  '42501', null, 'ni cierra una');
select throws_ok(
  $$select private.close_other_sessions('5e560000-0000-0000-0000-000000000001')$$,
  '42501', null, 'ni las demás');
select pruebas.como_servicio('b0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update private.app_sessions set user_agent = 'x'$$,
  '42501', null, 'el servidor no etiqueta escribiendo la tabla');
select throws_ok(
  $$delete from private.app_sessions$$,
  '42501', null, 'ni borra lo anotado');
select throws_ok(
  $$delete from auth.sessions$$,
  '42501', null, 'ni borra sesiones de Auth');

select pruebas.limpiar();
select * from finish();
rollback;
