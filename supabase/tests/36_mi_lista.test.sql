-- T-210, tercera solicitud · Mi lista (RF-311, PA-20, PA-02, FL-11 paso 6). Esquema §5.2.
-- Decisión de Sergio del 2026-10-28: la escribe el servidor y la persona solo lee la suya. El
-- guardián (decisión mía sin confirmar) exige que el curso esté listado y publicado y que la fila
-- sea de la persona por la que actúa el servidor: la base lo impide aunque la consulta se
-- equivoque. Un curso que deja de estar listado no se borra de la lista: la lectura lo oculta, y
-- vuelve si se lista otra vez. Las reglas nuevas del área `catalog` del vigilante se provocan aquí.
begin;
\ir _ayuda.psql
select plan(52);

select pruebas.alta('a3600000-0000-0000-0000-000000000001', 'ana-lista@prueba.test');
select pruebas.alta('a3600000-0000-0000-0000-000000000002', 'beto-lista@prueba.test');
select pruebas.alta('b3600000-0000-0000-0000-000000000001', 'contenido-lista@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-lista@prueba.test';
select pruebas.dar_capacidad('b3600000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b3600000-0000-0000-0000-000000000001');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a3600000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a3600000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.curso_lista(p_slug text) returns uuid
language sql as $$ select course_id from public.published_courses where slug = p_slug $$;
create function pruebas.curso_de_lista(p_slug text, p_title text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', p_title, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'Asset' || replace(p_slug, '-', ''), 'playback_id',
                           'Playback' || replace(p_slug, '-', ''), 'duration_seconds', 100))))))
$$;
-- Guarda, como el servidor a nombre de `p_actor`, la fila de `p_profile` con el curso `p_slug`.
create function pruebas.guarda(p_actor uuid, p_profile uuid, p_slug text) returns void
language plpgsql as $$
begin
  perform pruebas.a_nombre_de(p_actor);
  insert into public.saved_courses (profile_id, course_id) values (p_profile, pruebas.curso_lista(p_slug));
  perform pruebas.limpiar();
end
$$;
-- Lo que la persona ve de su lista, por slug.
create function pruebas.ve(p_id uuid) returns text[]
language plpgsql as $$
declare
  v text[];
begin
  perform pruebas.como_usuario(p_id);
  select coalesce(array_agg(c.slug order by c.slug), '{}') into v
  from public.saved_courses s join public.published_courses c on c.course_id = s.course_id;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Lo que hay en la tabla, sin seguridad por fila.
create function pruebas.filas() returns text[]
language sql as $$
  select coalesce(array_agg(p.email || ':' || c.slug order by p.email, c.slug), '{}')
  from public.saved_courses s
  join public.published_courses c on c.course_id = s.course_id
  join auth.users p on p.id = s.profile_id
$$;
-- Los problemas que el vigilante dice de la tabla, ordenados.
create function pruebas.vigila_lista() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations() v
  where v.object_name = 'public.saved_courses'
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- Dos cursos aprobados y uno que nunca se aprobó.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra de la lista', 'maestra-de-la-lista', null) as id;
select private.system_load_course((select id from maestra), pruebas.curso_de_lista('lista-uno', 'Lista uno'));
select private.system_load_course((select id from maestra), pruebas.curso_de_lista('lista-dos', 'Lista dos'));
select private.system_load_course((select id from maestra), pruebas.curso_de_lista('lista-sin-aprobar', 'Lista sin aprobar'));
select pruebas.limpiar();
select is(pruebas.pide('b3600000-0000-0000-0000-000000000001', format('private.approve_course(%L)', pruebas.curso_lista(slug))),
  'approved', 'se aprueba ' || slug)
  from (values ('lista-uno'), ('lista-dos')) as t (slug);
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id) values
  (pruebas.sesion(pruebas.ana()), pruebas.ana()), (pruebas.sesion(pruebas.beto()), pruebas.beto());

-- ---------------------------------------------------------------------------------------
-- La estructura.

select has_table('public', 'saved_courses', 'existe public.saved_courses');
select columns_are('public', 'saved_courses', array['profile_id', 'course_id', 'created_at'], 'con sus tres columnas');
select col_is_pk('public', 'saved_courses', array['profile_id', 'course_id'], 'una fila por persona y curso');
select is(
  (select confdeltype from pg_constraint
   where conrelid = 'public.saved_courses'::regclass and contype = 'f' and confrelid = 'public.profiles'::regclass),
  'c'::"char", 'si se borra un perfil, se borra su lista');
select is(
  (select confdeltype from pg_constraint
   where conrelid = 'public.saved_courses'::regclass and contype = 'f' and confrelid = 'public.published_courses'::regclass),
  'a'::"char", 'el curso es uno publicado, y lo publicado no se borra');
select ok((select relrowsecurity from pg_class where oid = 'public.saved_courses'::regclass), 'con seguridad por fila');
select policies_are('public', 'saved_courses', array['saved_courses_self_select'], 'una sola política');
select policy_cmd_is('public', 'saved_courses', 'saved_courses_self_select', 'select', 'que solo lee');
select policy_roles_are('public', 'saved_courses', 'saved_courses_self_select', array['authenticated'], 'para la persona con sesión');
select table_privs_are('public', 'saved_courses', 'anon', '{}'::text[], 'el visitante, nada');
select table_privs_are('public', 'saved_courses', 'authenticated', array['SELECT'], 'la persona, solo leer');
select table_privs_are('public', 'saved_courses', 'app_service', array['DELETE', 'INSERT', 'SELECT'],
  'el servidor lee, guarda y quita, sin editar');
select table_privs_are('public', 'saved_courses', 'service_role', '{}'::text[], 'la clave secreta, nada');
select has_trigger('public', 'saved_courses', 'saved_courses_guard', 'tiene su guardián');
select is_empty('select * from private.schema_violations()', 'y el vigilante no dice nada');

-- ---------------------------------------------------------------------------------------
-- El servidor guarda a nombre de quien actúa, solo lo listado.

select lives_ok($$select pruebas.guarda(pruebas.ana(), pruebas.ana(), 'lista-uno')$$, 'el servidor guarda un curso listado');
select lives_ok($$select pruebas.guarda(pruebas.ana(), pruebas.ana(), 'lista-dos')$$, 'y otro');
select lives_ok($$select pruebas.guarda(pruebas.beto(), pruebas.beto(), 'lista-uno')$$, 'y a nombre de otra persona, el suyo');
select is(pruebas.filas(),
  array['ana-lista@prueba.test:lista-dos', 'ana-lista@prueba.test:lista-uno', 'beto-lista@prueba.test:lista-uno'],
  'quedan las tres filas');
select throws_ok($$select pruebas.guarda(pruebas.ana(), pruebas.ana(), 'lista-uno')$$, '23505', null,
  'el mismo curso dos veces es una sola fila');
select throws_ok($$select pruebas.guarda(pruebas.ana(), pruebas.ana(), 'lista-sin-aprobar')$$, '23514', null,
  'un curso sin aprobar no se guarda');
select throws_ok($$select pruebas.guarda(pruebas.ana(), pruebas.beto(), 'lista-dos')$$, '42501', null,
  'ni a nombre de otra persona que la que actúa');

select pruebas.como_sistema();
select throws_ok($$insert into public.saved_courses (profile_id, course_id) values (pruebas.beto(), pruebas.curso_lista('lista-dos'))$$,
  '42501', null, 'un trabajo del sistema no guarda: no hay persona');
select pruebas.limpiar();

select pruebas.a_nombre_de(pruebas.ana());
select throws_ok($$update public.saved_courses set created_at = now() where profile_id = pruebas.ana()$$,
  '42501', null, 'el servidor no edita una fila');
select throws_ok($$truncate public.saved_courses$$, '42501', null, 'ni vacía la tabla');
select pruebas.limpiar();

-- El dueño tampoco guarda sin persona: el guardián no mira quién escribe, sino por quién.
select pruebas.como_dueno();
select throws_ok($$insert into public.saved_courses (profile_id, course_id) values (pruebas.beto(), pruebas.curso_lista('lista-dos'))$$,
  '42501', null, 'el dueño sin persona declarada, tampoco');

-- ---------------------------------------------------------------------------------------
-- La persona lee la suya, y nada más.

select is(pruebas.ve(pruebas.ana()), array['lista-dos', 'lista-uno'], 'la persona ve su lista');
select is(pruebas.ve(pruebas.beto()), array['lista-uno'], 'y la otra, la suya');

select pruebas.como_usuario(pruebas.ana());
select throws_ok($$insert into public.saved_courses (profile_id, course_id) values (pruebas.ana(), pruebas.curso_lista('lista-dos'))$$,
  '42501', null, 'la persona no escribe directo');
select throws_ok($$delete from public.saved_courses where profile_id = pruebas.ana()$$, '42501', null, 'ni borra directo');
select throws_ok($$update public.saved_courses set created_at = now()$$, '42501', null, 'ni edita');
select pruebas.limpiar();

select pruebas.como_visitante();
select throws_ok($$select count(*) from public.saved_courses$$, '42501', null, 'el visitante no la lee');
select pruebas.limpiar();

-- Quitar, a nombre de quien actúa: el servidor borra con la persona en la consulta.
select pruebas.a_nombre_de(pruebas.ana());
delete from public.saved_courses where profile_id = pruebas.ana() and course_id = pruebas.curso_lista('lista-dos');
select pruebas.limpiar();
select is(pruebas.ve(pruebas.ana()), array['lista-uno'], 'el servidor quita un curso de la lista');

-- ---------------------------------------------------------------------------------------
-- Un curso que deja de estar listado: no se guarda de nuevo, y lo guardado se queda.

select pruebas.como_dueno_sistema();
update public.published_courses set is_listed = false where slug = 'lista-uno';
select pruebas.limpiar();
select lives_ok($$select pruebas.guarda(pruebas.beto(), pruebas.beto(), 'lista-dos')$$, 'el otro, listado, sí');
select throws_ok($$select pruebas.guarda(pruebas.ana(), pruebas.ana(), 'lista-uno')$$, '23514', null,
  'uno que dejó de estar listado no se guarda');
select is(pruebas.filas(),
  array['ana-lista@prueba.test:lista-uno', 'beto-lista@prueba.test:lista-dos', 'beto-lista@prueba.test:lista-uno'],
  'lo ya guardado se queda: la lectura lo oculta, y vuelve si se lista otra vez');

-- Retirado, aunque siguiera marcado como listado: el registro manda.
select pruebas.como_dueno_sistema();
update public.published_courses set is_listed = true where slug = 'lista-uno';
update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'prueba', is_open = false
  where course_id = pruebas.curso_lista('lista-uno');
select pruebas.limpiar();
select throws_ok($$select pruebas.guarda(pruebas.ana(), pruebas.ana(), 'lista-uno')$$, '23514', null,
  'un curso retirado no se guarda, aunque diga listado');

-- Publicado otra vez, se guarda de nuevo.
select pruebas.a_nombre_de(pruebas.ana());
delete from public.saved_courses where profile_id = pruebas.ana();
select pruebas.limpiar();
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'published', withdrawn_at = null, withdrawal_reason = null
  where course_id = pruebas.curso_lista('lista-uno');
select pruebas.limpiar();
select lives_ok($$select pruebas.guarda(pruebas.ana(), pruebas.ana(), 'lista-uno')$$, 'publicado otra vez, se guarda');

-- ---------------------------------------------------------------------------------------
-- Si se borra un perfil (en producción queda lápida; las pruebas sí los borran).

select pruebas.como_dueno();
delete from public.profiles where id = pruebas.beto();
select is(pruebas.filas(), array['ana-lista@prueba.test:lista-uno'], 'la lista de un perfil borrado se va con él');

-- ---------------------------------------------------------------------------------------
-- Las reglas nuevas del área `catalog`: cada una se provoca y se deshace.

select pruebas.como_dueno();
grant insert on public.saved_courses to authenticated;
select is(pruebas.vigila_lista(), array['saved list writable by authenticated'],
  'guardar directo, la persona (aunque el área base aún lo permite)');
revoke insert on public.saved_courses from authenticated;
grant delete on public.saved_courses to authenticated;
select is(pruebas.vigila_lista(), array['saved list writable by authenticated'], 'quitar directo, la persona');
revoke delete on public.saved_courses from authenticated;
grant select on public.saved_courses to anon;
select is(pruebas.vigila_lista(), array['saved list readable by anon'], 'leerla, el visitante');
revoke select on public.saved_courses from anon;
grant update (created_at) on public.saved_courses to app_service;
select is(pruebas.vigila_lista(), array['saved list editable by app_service'], 'editar una columna, el servidor');
revoke update (created_at) on public.saved_courses from app_service;
grant truncate on public.saved_courses to app_service;
select is(pruebas.vigila_lista(), array['saved list editable by app_service'], 'vaciarla, el servidor');
revoke truncate on public.saved_courses from app_service;
create policy zz_todo on public.saved_courses for select to authenticated using (true);
select is(pruebas.vigila_lista(), array['saved list policy other than self read'], 'otra política de lectura');
drop policy zz_todo on public.saved_courses;
create policy zz_guardar on public.saved_courses for insert to authenticated with check (profile_id = (select auth.uid()));
select is(pruebas.vigila_lista(), array['saved list policy other than self read'], 'una política de escritura');
drop policy zz_guardar on public.saved_courses;
alter policy saved_courses_self_select on public.saved_courses to anon, authenticated;
select is(pruebas.vigila_lista(), array['saved list policy other than self read'], 'la propia, también para el visitante');
alter policy saved_courses_self_select on public.saved_courses to authenticated;
alter policy saved_courses_self_select on public.saved_courses using (true);
select is(pruebas.vigila_lista(), array['saved list policy other than self read'], 'la propia, sin mirar de quién es la fila');
alter policy saved_courses_self_select on public.saved_courses using (profile_id = (select auth.uid()));
alter table public.saved_courses disable trigger saved_courses_guard;
select is(pruebas.vigila_lista(), array['saved list without insert guard'], 'el guardián apagado');
alter table public.saved_courses enable trigger saved_courses_guard;
select is_empty('select * from private.schema_violations()', 'deshecho todo, el vigilante otra vez no dice nada');

select * from finish();
rollback;
