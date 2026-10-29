-- T-401, primera solicitud: el maestro activo en el guardián de lo publicado (RF-702; criterio del 06:
-- un maestro suspendido no puede enviar cursos; decisión de Sergio del 2026-10-29). Las funciones del
-- borrador de T-402 escriben `course_registry` como el dueño de la tabla, a nombre del maestro que el
-- servidor declara: aquí se escribe igual (pruebas.dueno_por_maestro). Lo que pasa a su nombre es dar de
-- alta un borrador limpio suyo y borrar un borrador suyo que nunca se publicó; nada más, y en ninguna
-- otra tabla.
begin;
\ir _ayuda.psql
select plan(47);

create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a4010000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a4010000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- Un maestro con cuenta, en el estado que se diga, escrito como el dueño declarado sistema.
create function pruebas.maestro(p_n integer, p_profile uuid, p_status public.teacher_status) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (id, profile_id, status, suspended_at, suspension_reason)
  values (pruebas.m(p_n), p_profile, p_status,
          case when p_status = 'suspended' then now() end, case when p_status = 'suspended' then 'prueba' end);
  perform pruebas.limpiar();
end
$$;
-- El dueño de la tabla a nombre de una persona, como lo hará una función del borrador que el servidor llama.
create function pruebas.dueno_por_maestro(p_id uuid) returns void language sql
as $$ select pruebas.limpiar(); select set_config('app.actor_id', p_id::text, true); $$;
-- El dueño de la tabla dentro de una petición de la persona (con su sesión, sin cambiar de rol).
create function pruebas.dueno_en_sesion_de(p_id uuid) returns void language sql
as $$
  select pruebas.limpiar();
  select set_config('request.jwt.claims',
           json_build_object('sub', p_id, 'role', 'authenticated', 'session_id', pruebas.sesion(p_id))::text, true);
$$;
-- El dueño a nombre de alguien con su sesión: así pasa la puerta de Contenido quien la tiene.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void language sql
as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;
-- Un curso del maestro en el estado que se diga, puesto por el sistema.
create function pruebas.curso(p_id uuid, p_teacher uuid, p_state public.course_state, p_published boolean default false)
returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into public.course_registry (course_id, teacher_id, state, first_published_at)
  values (p_id, p_teacher, p_state, case when p_published then now() end);
  perform pruebas.limpiar();
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- La activa (1), la suspendida como maestra (2), la activa con la cuenta suspendida (3), una alumna sin
-- maestro (4), otro maestro activo (5) y una persona con Contenido (6).
select pruebas.alta(pruebas.p(n), 'maestra-activa-' || n || '@prueba.test') from generate_series(1, 6) n;
select pruebas.maestro(1, pruebas.p(1), 'active'), pruebas.maestro(2, pruebas.p(2), 'suspended'),
       pruebas.maestro(3, pruebas.p(3), 'active'), pruebas.maestro(5, pruebas.p(5), 'active');
select pruebas.suspender(pruebas.p(3));
select pruebas.confirmar(pruebas.p(6));
select pruebas.dar_capacidad(pruebas.p(6), 'content');
select pruebas.equipar(pruebas.p(6));

-- ---------------------------------------------------------------------------------------
-- El maestro activo de quien actúa: dentro de las funciones del dueño, por el servidor y por la sesión.

select pruebas.dueno_por_maestro(pruebas.p(1));
select is(private.current_active_teacher_id(), pruebas.m(1), 'por el servidor, la maestra activa es ella');
select pruebas.dueno_en_sesion_de(pruebas.p(1));
select is(private.current_active_teacher_id(), pruebas.m(1), 'y por su sesión, también');
select pruebas.dueno_por_maestro(pruebas.p(2));
select is(private.current_active_teacher_id(), null, 'la suspendida como maestra no es maestra activa');
select pruebas.dueno_por_maestro(pruebas.p(3));
select is(private.current_active_teacher_id(), null, 'ni la de la cuenta suspendida');
select pruebas.dueno_por_maestro(pruebas.p(4));
select is(private.current_active_teacher_id(), null, 'ni una alumna sin maestro');
select pruebas.como_dueno_sistema();
select is(private.current_active_teacher_id(), null, 'ni un trabajo del sistema');
select pruebas.como_dueno();
-- Toma un candado: solo dentro de una escritura, así que ningún rol de la aplicación la ejecuta.
select ok(not has_function_privilege(r, 'private.current_active_teacher_id()', 'execute'), r || ' no la ejecuta')
from unnest(array['anon', 'authenticated', 'app_service']) r;

-- Toma la fila del maestro para compartir: suspenderlo en otra transacción espera a quien escribe a su
-- nombre. Una fila tomada lleva en `xmax` la transacción que la tomó.
select is((select xmax from public.teachers where id = pruebas.m(5)), '0'::xid, 'el otro maestro no está tomado');
select pruebas.dueno_por_maestro(pruebas.p(5));
select private.current_active_teacher_id();
select pruebas.como_dueno();
select is((select xmax from public.teachers where id = pruebas.m(5)), pg_current_xact_id()::xid,
  'leerlo como maestro activo toma su fila');

-- ---------------------------------------------------------------------------------------
-- Dar de alta, a nombre del maestro.

select pruebas.dueno_por_maestro(pruebas.p(1));
select lives_ok($$insert into public.course_registry (course_id, teacher_id) values (pruebas.m(101), pruebas.m(1))$$,
  'la activa da de alta un borrador suyo');
select throws_ok($$insert into public.course_registry (teacher_id) values (pruebas.m(5))$$, '42501', null,
  'pero no uno de otro maestro');
select throws_ok($$insert into public.course_registry (teacher_id, state) values (pruebas.m(1), 'in_review')$$, '42501', null,
  'ni uno que no nazca en borrador');
select throws_ok($$insert into public.course_registry (teacher_id, first_published_at) values (pruebas.m(1), now())$$, '42501', null,
  'ni uno que diga que ya se publicó');
select throws_ok($$insert into public.course_registry (teacher_id, withdrawn_at, withdrawal_reason)
                   values (pruebas.m(1), now(), 'no')$$, '42501', null,
  'ni uno retirado');
select throws_ok($$insert into public.course_registry (teacher_id, withdrawal_reason) values (pruebas.m(1), 'no')$$, '42501', null,
  'ni uno con motivo de retiro');
select throws_ok($$insert into public.course_registry (teacher_id, withdrawn_by) values (pruebas.m(1), pruebas.p(1))$$, '42501', null,
  'ni uno con quien lo retiró');
select throws_ok($$insert into public.course_registry (teacher_id, state, pending_version_state)
                   values (pruebas.m(1), 'draft', 'draft')$$, '42501', null,
  'ni uno con versión pendiente');
select throws_ok($$insert into public.course_registry (teacher_id, created_at) values (pruebas.m(1), now() - interval '1 year')$$,
  '42501', null, 'ni uno fechado hacia atrás');
select pruebas.dueno_por_maestro(pruebas.p(2));
select throws_ok($$insert into public.course_registry (teacher_id) values (pruebas.m(2))$$, '42501', null,
  'la suspendida no da de alta nada: un suspendido no envía cursos');
select pruebas.dueno_por_maestro(pruebas.p(3));
select throws_ok($$insert into public.course_registry (teacher_id) values (pruebas.m(3))$$, '42501', null,
  'ni la de la cuenta suspendida');
select pruebas.dueno_por_maestro(pruebas.p(4));
select throws_ok($$insert into public.course_registry (teacher_id) values (pruebas.m(1))$$, '42501', null,
  'ni una alumna a nombre de una maestra');
select pruebas.como_dueno();
select throws_ok($$insert into public.course_registry (teacher_id) values (pruebas.m(1))$$, '42501', null,
  'ni el dueño sin nadie declarado');

-- El paso es solo del registro de cursos: a su nombre no se escribe ninguna otra tabla de lo publicado.
select pruebas.dueno_por_maestro(pruebas.p(1));
select throws_ok($$insert into public.video_assets (course_id, teacher_id, lesson_id, provider)
                   values (pruebas.m(101), pruebas.m(1), gen_random_uuid(), 'mux')$$, '42501', null,
  'ni un video de su borrador');
select throws_ok($$update public.teachers set updated_at = now() where id = pruebas.m(1)$$, '42501', null,
  'ni su propia fila de maestro');

-- ---------------------------------------------------------------------------------------
-- Cambiar y borrar, a nombre del maestro.

select pruebas.curso(pruebas.m(102), pruebas.m(1), 'in_review');
select pruebas.curso(pruebas.m(103), pruebas.m(1), 'draft', true);
select pruebas.curso(pruebas.m(104), pruebas.m(5), 'draft');
select pruebas.curso(pruebas.m(105), pruebas.m(3), 'draft');
select pruebas.curso(pruebas.m(106), pruebas.m(1), 'draft');
select pruebas.como_dueno_sistema();
insert into public.video_assets (course_id, teacher_id, lesson_id, provider)
values (pruebas.m(106), pruebas.m(1), gen_random_uuid(), 'mux');
select pruebas.dueno_por_maestro(pruebas.p(1));
select throws_ok($$update public.course_registry set updated_at = now() where course_id = pruebas.m(101)$$, '42501', null,
  'nada se cambia a su nombre, ni un borrador suyo');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(102)$$, '42501', null,
  'no borra lo que envió a revisión');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(103)$$, '42501', null,
  'ni un borrador de lo que ya se publicó');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(104)$$, '42501', null,
  'ni el borrador de otro');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(106)$$, '23503', null,
  'ni un borrador que ya tiene un video: la clave no borra en cascada');
select lives_ok($$delete from public.course_registry where course_id = pruebas.m(101)$$,
  'borra un borrador suyo que nunca se publicó');
select pruebas.como_dueno();
select is((select count(*)::integer from public.course_registry where course_id = pruebas.m(101)), 0, 'y ya no está');
select is((select actor_id from public.audit_log
           where action = 'course_registry.delete' and entity_id = pruebas.m(101)::text),
          pruebas.p(1), 'la auditoría guarda el borrado, con su curso y quién lo hizo');
select pruebas.dueno_por_maestro(pruebas.p(3));
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(105)$$, '42501', null,
  'con la cuenta suspendida, no borra su borrador');

-- Suspendido a media sesión, deja de pasar en el acto.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = pruebas.m(5);
select pruebas.dueno_por_maestro(pruebas.p(5));
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(104)$$, '42501', null,
  'suspendido, tampoco borra su borrador');

-- El sistema y Contenido siguen como estaban: escriben, y no borran.
select pruebas.como_dueno_sistema();
select lives_ok($$insert into public.course_registry (teacher_id, state) values (pruebas.m(1), 'in_review')$$,
  'el sistema sigue dando de alta en cualquier estado');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(104)$$, '42501', null,
  'y sigue sin borrar');
select pruebas.dueno_a_nombre_de(pruebas.p(6));
select lives_ok($$update public.course_registry set state = 'draft' where course_id = pruebas.m(102)$$,
  'Contenido sigue cambiando el registro');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(104)$$, '42501',
  'public.course_registry: rows are hidden, not deleted', 'y sigue sin borrar, ni un borrador');

-- ---------------------------------------------------------------------------------------
-- El vigilante del área.

select pruebas.como_dueno();
select is_empty($$select * from private.schema_violations_teachers()$$, 'el área de maestros está en orden');
grant execute on function private.current_active_teacher_id() to app_service;
select ok(exists (select 1 from private.schema_violations_teachers() where problem = 'teachers function executable by app_service'),
  'el vigilante ve que el servidor la ejecuta');
revoke execute on function private.current_active_teacher_id() from app_service;
alter function private.current_active_teacher_id() stable;
select ok(exists (select 1 from private.schema_violations_teachers() where problem = 'teachers function not volatile'),
  'que dejó de ser volátil');
alter function private.current_active_teacher_id() volatile security invoker;
select ok(exists (select 1 from private.schema_violations_teachers() where problem = 'teachers function not security definer'),
  'que dejó de ser security definer');
alter function private.current_active_teacher_id() security definer;
alter table public.course_registry disable trigger publication_guard;
select ok(exists (select 1 from private.schema_violations_teachers()
                  where problem = 'teachers trigger missing or disabled: publication_guard'),
  'y que el guardián del registro de cursos está apagado');
alter table public.course_registry enable trigger publication_guard;
-- Con el mismo nombre pero después de escribir, ya no detiene nada.
drop trigger publication_guard on public.course_registry;
create trigger publication_guard after insert or update or delete on public.course_registry
  for each row execute function private.guard_publication();
select ok(exists (select 1 from private.schema_violations_teachers()
                  where problem = 'teachers trigger missing or disabled: publication_guard'),
  'ni que el guardián corra después de escribir');
drop trigger publication_guard on public.course_registry;
create trigger publication_guard before insert or update or delete on public.course_registry
  for each row execute function private.guard_publication();
select is_empty($$select * from private.schema_violations_teachers()$$, 'restaurado, en orden otra vez');

select * from finish();
rollback;
