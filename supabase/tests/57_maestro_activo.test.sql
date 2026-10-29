-- T-401, primera solicitud: el maestro activo en el guardián de lo publicado (RF-702; criterio del 06:
-- un maestro suspendido no puede enviar cursos; decisión de Sergio del 2026-10-29). Las funciones del
-- borrador de T-402 escriben `course_registry` como el dueño de la tabla, a nombre del maestro que el
-- servidor declara: aquí se escribe igual (pruebas.dueno_por_maestro). Lo que pasa a su nombre es dar de
-- alta un borrador limpio suyo y borrar un borrador suyo que nunca se publicó; nada más.
begin;
\ir _ayuda.psql
select plan(31);

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
-- maestro (4) y otro maestro activo (5).
select pruebas.alta(pruebas.p(n), 'maestra-activa-' || n || '@prueba.test') from generate_series(1, 5) n;
select pruebas.maestro(1, pruebas.p(1), 'active'), pruebas.maestro(2, pruebas.p(2), 'suspended'),
       pruebas.maestro(3, pruebas.p(3), 'active'), pruebas.maestro(5, pruebas.p(5), 'active');
select pruebas.suspender(pruebas.p(3));

-- ---------------------------------------------------------------------------------------
-- El maestro activo de la sesión, por el servidor y como la persona.

select pruebas.a_nombre_de(pruebas.p(1));
select is(private.current_active_teacher_id(), pruebas.m(1), 'por el servidor, la maestra activa es ella');
select pruebas.como_usuario(pruebas.p(1));
select is(private.current_active_teacher_id(), pruebas.m(1), 'y como la persona, también');
select pruebas.a_nombre_de(pruebas.p(2));
select is(private.current_active_teacher_id(), null, 'la suspendida como maestra no es maestra activa');
select pruebas.a_nombre_de(pruebas.p(3));
select is(private.current_active_teacher_id(), null, 'ni la de la cuenta suspendida');
select pruebas.a_nombre_de(pruebas.p(4));
select is(private.current_active_teacher_id(), null, 'ni una alumna sin maestro');
select pruebas.como_sistema();
select is(private.current_active_teacher_id(), null, 'ni un trabajo del sistema');
select pruebas.como_visitante();
select throws_ok($$select private.current_active_teacher_id()$$, '42501', null, 'el visitante no la ejecuta');
select pruebas.como_dueno();

-- Toma la fila del maestro para compartir: suspenderlo en otra transacción espera a quien escribe a su
-- nombre. Una fila tomada lleva en `xmax` la transacción que la tomó.
select is((select xmax from public.teachers where id = pruebas.m(5)), '0'::xid, 'el otro maestro no está tomado');
select pruebas.a_nombre_de(pruebas.p(5));
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
select throws_ok($$insert into public.course_registry (teacher_id, state, pending_version_state)
                   values (pruebas.m(1), 'draft', 'draft')$$, '42501', null,
  'ni uno con versión pendiente');
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

-- ---------------------------------------------------------------------------------------
-- Cambiar y borrar, a nombre del maestro.

select pruebas.curso(pruebas.m(102), pruebas.m(1), 'in_review');
select pruebas.curso(pruebas.m(103), pruebas.m(1), 'draft', true);
select pruebas.curso(pruebas.m(104), pruebas.m(5), 'draft');
select pruebas.dueno_por_maestro(pruebas.p(1));
select throws_ok($$update public.course_registry set updated_at = now() where course_id = pruebas.m(101)$$, '42501', null,
  'nada se cambia a su nombre, ni un borrador suyo');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(102)$$, '42501', null,
  'no borra lo que envió a revisión');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(103)$$, '42501', null,
  'ni un borrador de lo que ya se publicó');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(104)$$, '42501', null,
  'ni el borrador de otro');
select lives_ok($$delete from public.course_registry where course_id = pruebas.m(101)$$,
  'borra un borrador suyo que nunca se publicó');
select pruebas.como_dueno();
select is((select count(*)::integer from public.course_registry where course_id = pruebas.m(101)), 0, 'y ya no está');

-- Suspendida a media sesión, deja de pasar en el acto.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = pruebas.m(5);
select pruebas.dueno_por_maestro(pruebas.p(5));
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(104)$$, '42501', null,
  'suspendido, tampoco borra su borrador');

-- El sistema sigue como estaba: escribe, y no borra.
select pruebas.como_dueno_sistema();
select lives_ok($$insert into public.course_registry (teacher_id, state) values (pruebas.m(1), 'in_review')$$,
  'el sistema sigue dando de alta en cualquier estado');
select throws_ok($$delete from public.course_registry where course_id = pruebas.m(104)$$, '42501', null,
  'y sigue sin borrar');

-- ---------------------------------------------------------------------------------------
-- El vigilante del área.

select pruebas.como_dueno();
select is_empty($$select * from private.schema_violations_teachers()$$, 'el área de maestros está en orden');
grant execute on function private.current_active_teacher_id() to anon;
select ok(exists (select 1 from private.schema_violations_teachers() where problem like '%executable by anon'),
  'el vigilante ve que el visitante la ejecuta');
revoke execute on function private.current_active_teacher_id() from anon;
alter function private.current_active_teacher_id() security invoker;
select ok(exists (select 1 from private.schema_violations_teachers() where problem like '%not security definer'),
  'y que dejó de ser security definer');

select * from finish();
rollback;
