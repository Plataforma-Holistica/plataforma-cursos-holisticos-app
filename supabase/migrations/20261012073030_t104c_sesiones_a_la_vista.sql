-- T-104 · Las sesiones a la vista (RF-109). TRD §9.2, esquema §5.9 y §6.2; diseño, PA-25.
-- Tercera entrega de T-104.
--
-- Una persona ve en su cuenta las sesiones que tiene abiertas, cierra una y cierra todas
-- las demás. «Abiertas» son las que la aplicación reconoce: las que el servidor anotó y
-- siguen vivas en Supabase Auth. Una sesión abierta directo en Auth no se lista, porque
-- tampoco entra; «cerrar las demás» sí se la lleva.
--
-- Tres cosas que esta migración decide:
--
--   · Ninguna función recibe de quién es la cuenta. Todas actúan sobre la cuenta por la que
--     el servidor declaró actuar, con el token que verificó (private.actor_id()).
--   · Cerrar es borrar la fila de auth.sessions. Sus tokens de renovación se van con ella
--     (clave foránea con cascada), así que la sesión ya no se puede renovar; y como la
--     guarda mira lo anotado en cada entrada, deja de pasar en el acto, sin esperar a que
--     venza su token de acceso. Estas dos funciones son la única manera en que el servidor
--     borra una sesión de Auth: no tiene permisos sobre esa tabla.
--   · De qué navegador es cada sesión lo dice la aplicación, no Auth. Las columnas
--     user_agent e ip de auth.sessions se reescriben en cada renovación con los del
--     servidor (medido contra el Auth local el 2026-10-11): no describen el dispositivo. La
--     última actividad sí sale de Auth, de updated_at.
--
-- Lo que da por sentado: que quien aplica la migración puede borrar en auth.sessions. En
-- local es así. En un proyecto alojado hay que medirlo antes de dar esto por bueno.

-- ---------------------------------------------------------------------------------------
-- El navegador desde el que se abrió cada sesión.

alter table private.app_sessions
  add column user_agent text
  constraint app_sessions_user_agent_length check (char_length(user_agent) <= 512);
comment on column private.app_sessions.user_agent is 'La cabecera User-Agent de la petición que abrió la sesión, recortada. Solo para que su dueña la reconozca en la lista: no decide nada. La pone private.tag_session(), una vez.';
comment on table private.app_sessions is 'Las sesiones que abrió la aplicación. Una sesión de Auth que no está aquí no entra. Se anota con private.note_session(), se etiqueta con private.tag_session() y se borra al cerrarla o al reclamar la cuenta.';

-- ---------------------------------------------------------------------------------------
-- Etiquetar una sesión recién anotada. Aparte de private.note_session() a propósito: darle
-- otro parámetro crearía una función nueva y dejaría viva la de antes.
--
--   tagged      quedó etiquetada
--   kept        ya lo estaba, o no había nada que poner: la etiqueta es de cuando se abrió
--   not_noted   esa sesión no está anotada para quien actúa
--   ineligible  sin actor o sin identificador de sesión

create function private.tag_session(p_session uuid, p_user_agent text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_label text := pg_catalog.left(p_user_agent, 512);
  v_current text;
begin
  if v_actor is null or p_session is null then
    return 'ineligible';
  end if;
  select x.user_agent into v_current
  from private.app_sessions x
  where x.session_id = p_session and x.profile_id = v_actor
  for update;
  if not found then
    return 'not_noted';
  end if;
  if v_current is not null or v_label is null or v_label = '' then
    return 'kept';
  end if;
  update private.app_sessions set user_agent = v_label
  where session_id = p_session and profile_id = v_actor;
  return 'tagged';
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las sesiones abiertas de quien actúa: anotadas y vivas en Auth. La de actividad más
-- reciente va primero.

create function private.list_sessions()
returns table (session_id uuid, opened_at timestamptz, last_active_at timestamptz, user_agent text)
language sql stable security definer set search_path = ''
as $$
  select x.session_id, x.opened_at, a.updated_at, x.user_agent
  from private.app_sessions x
  join auth.sessions a on a.id = x.session_id and a.user_id = x.profile_id
  where x.profile_id = private.actor_id()
    and (a.not_after is null or a.not_after > pg_catalog.clock_timestamp())
  order by a.updated_at desc nulls last, x.opened_at desc, x.session_id
$$;

-- ---------------------------------------------------------------------------------------
-- Cerrar una sesión de quien actúa: la borra en Auth y quita lo anotado, en una transacción.
--
--   closed      había algo que cerrar, en Auth o entre lo anotado, y ya no está
--   not_found   esa sesión no es de quien actúa, o no existe
--   ineligible  sin actor o sin identificador de sesión
--
-- Cada borrado filtra por su propia columna de dueño: una fila mal anotada, a nombre de una
-- cuenta con la sesión de otra en Auth, se quita de lo anotado sin tocar la sesión ajena.

create function private.close_session(p_session uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_in_auth integer;
  v_noted integer;
begin
  if v_actor is null or p_session is null then
    return 'ineligible';
  end if;
  delete from auth.sessions a where a.id = p_session and a.user_id = v_actor;
  get diagnostics v_in_auth = row_count;
  delete from private.app_sessions x where x.session_id = p_session and x.profile_id = v_actor;
  get diagnostics v_noted = row_count;
  if v_in_auth + v_noted = 0 then
    return 'not_found';
  end if;
  return 'closed';
end
$$;

-- ---------------------------------------------------------------------------------------
-- Cerrar todas las sesiones de quien actúa menos una. Devuelve cuántas cerró en Auth, o
-- nulo si no cerró nada porque no podía.
--
-- La que se queda tiene que ser de quien actúa, estar anotada y seguir viva: con cualquier
-- otro valor esto cerraría todas, también la de quien lo pide.
--
-- Las demás se borran por cuenta, no por lo anotado: así se van también las sesiones
-- abiertas directo en Auth, que la aplicación no reconoce pero que siguen vivas allá.

create function private.close_other_sessions(p_keep uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_closed integer;
begin
  if v_actor is null or p_keep is null then
    return null;
  end if;
  if private.session_recognized(p_keep) <> 'recognized' then
    return null;
  end if;
  delete from auth.sessions a where a.user_id = v_actor and a.id <> p_keep;
  get diagnostics v_closed = row_count;
  delete from private.app_sessions x where x.profile_id = v_actor and x.session_id <> p_keep;
  return v_closed;
end
$$;

grant execute on function
  private.tag_session(uuid, text),
  private.list_sessions(),
  private.close_session(uuid),
  private.close_other_sessions(uuid)
  to app_service;
