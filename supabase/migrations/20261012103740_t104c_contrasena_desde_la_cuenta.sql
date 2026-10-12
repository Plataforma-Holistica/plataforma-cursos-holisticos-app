-- T-104 · Cambiar la contraseña desde la cuenta (RF-109). TRD §9.2, esquema §6.2; FL-27, paso 3.
-- Tercera entrega de T-104.
--
-- Cuando una persona con sesión cambia su contraseña, Supabase Auth guarda la nueva y cierra
-- las demás sesiones. La aplicación tiene que hacer su parte, que Auth no hace: fechar el
-- cambio y borrar lo que tenía anotado de esa cuenta. Sin eso, una entrada que Auth tenía a
-- medias con la contraseña de antes nace después del cambio, y quedaría anotada (la carrera
-- medida el 2026-10-10, la misma que cierra private.note_session() con la recuperación).
--
-- Reclamar una cuenta (private.claim_account()) ya fecha y borra, pero hace además dos cosas
-- que aquí no deben pasar:
--
--   · Apaga la marca de contraseña. Esa marca dice que la contraseña la fijó quien controla
--     el buzón, y solo se apaga al abrir un enlace del correo. Quien cambia su contraseña
--     desde la cuenta no demostró eso: demostró que sabe la contraseña de antes.
--   · Crea la fecha de una cuenta que no la tiene. Sin fecha, una cuenta no anota sesiones.
--
-- Por eso esta función va aparte, y no hace ninguna de las dos.

--   noted       el cambio quedó fechado y lo anotado de la cuenta se borró
--   unclaimed   la cuenta no tiene fecha de reclamo: no se le crea, y no se borra nada
--   ineligible  sin actor
--
-- Toma un candado de fila del perfil, que choca con el de private.note_session(): una
-- sesión se anota antes de esto, y esto la borra, o después, y ve la fecha nueva. Eso
-- supone que cada sentencia ve lo ya confirmado; con otro aislamiento se niega a correr.

create function private.note_password_change() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if v_actor is null then
    return 'ineligible';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.note_password_change() needs read committed isolation' using errcode = '25000';
  end if;
  perform 1 from public.profiles p where p.id = v_actor for no key update;

  update private.account_security s
  set password_changed_at = pg_catalog.clock_timestamp()
  where s.profile_id = v_actor;
  if not found then
    return 'unclaimed';
  end if;
  delete from private.app_sessions x where x.profile_id = v_actor;
  return 'noted';
end
$$;

grant execute on function private.note_password_change() to app_service;
