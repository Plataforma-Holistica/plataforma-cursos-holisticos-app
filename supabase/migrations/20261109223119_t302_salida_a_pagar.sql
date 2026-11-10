-- T-302, primera solicitud · La salida a pagar, en la base (RF-201, RF-202; plan aprobado por Sergio el 2026-11-09, en ~/.claude/plans/t302-planes-plan.md, con la
-- revisión independiente del diseño). Lo que pasa antes de mandar a alguien a la página de Stripe:
--
--   · La oferta (PA-04): los dos planes con el monto del parámetro (`PRECIO_MENSUAL`, `PRECIO_ANUAL`), la clave del precio en Stripe armada con ese monto
--     (decisión de Sergio del 2026-11-09: manda el parámetro, y el servidor busca el Price por `lookup_key`), la fecha del siguiente cobro con la regla de
--     Stripe (del 31 al último día del mes que sigue) y el texto del cobro recurrente que rige.
--   · Reservar la salida (`checkout_begin`), como la persona, con el candado de su cuenta y en una sola transacción: la cuenta activa y con el correo
--     verificado, sin un pago en curso (una suscripción viva, o una `pending` que Stripe no dio por terminada: alguien que ya pagó y cuyo aviso no se aplicó),
--     con lo que vio igual a lo vigente; anota el consentimiento del cobro recurrente sobre el texto vigente, con la IP y el navegador, y reserva la salida con
--     todo lo que irá a Stripe, para que un reintento mande exactamente lo mismo (la llave de idempotencia de Stripe solo cubre la misma petición con los
--     mismos parámetros). A lo más una salida abierta por cuenta.
--   · Un cliente de Stripe por cuenta y modo, reservado antes de crearlo: así no se crea uno nuevo en cada salida, y reactivar (FL-22) usa el mismo.
--   · Una salida se cierra con la palabra de Stripe (rechazó crearla, la venció, se completó con su suscripción), o cinco minutos después de su
--     vencimiento, cuando Stripe ya la venció por su cuenta; si Stripe la completó, lo vencido por el reloj se corrige. Una salida completada cuya
--     suscripción no llegó todavía con su aviso también es un pago en curso. Antes de crear otra, el servidor además le pregunta a Stripe por las
--     suscripciones del cliente (segunda solicitud).
--   · PA-32 lee si la sesión es de quien mira y si su suscripción ya está viva. Nunca da acceso: el acceso sigue saliendo de `billing_apply` con el aviso.
--
-- Nadie de la aplicación lee ni escribe las tablas: entra por estas puertas, solo del servidor. Lo prueba la 88, y las carreras la integración 116.

create type private.checkout_state as enum ('reserved', 'creating', 'open', 'completed', 'expired', 'abandoned', 'lapsed');

-- ---------------------------------------------------------------------------------------
-- El cliente de Stripe de cada cuenta.

create table private.billing_customers (
  profile_id uuid not null references public.profiles (id),
  livemode boolean not null,
  customer_id text,                           -- nulo hasta que Stripe lo crea y se anota
  reserved_at timestamptz not null default now(),
  recorded_at timestamptz,
  primary key (profile_id, livemode),
  constraint billing_customers_id_shape check (customer_id is null or customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  constraint billing_customers_recorded check ((customer_id is null) = (recorded_at is null))
);
comment on table private.billing_customers is 'El cliente de Stripe de cada cuenta y modo (T-302). Se reserva antes de crearlo y se anota una vez.';
create unique index billing_customers_customer_uq on private.billing_customers (livemode, customer_id) where customer_id is not null;
alter table private.billing_customers enable row level security;
revoke all on table private.billing_customers from public, anon, authenticated, service_role, app_service;

-- Un cliente anotado no cambia, y nada se borra.
create function private.guard_billing_customer() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%.%: a billing customer is never deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.profile_id is distinct from old.profile_id or new.livemode is distinct from old.livemode
                           or new.reserved_at is distinct from old.reserved_at or old.customer_id is not null) then
    raise exception '%.%: a recorded billing customer does not change', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function private.guard_billing_customer() from public;
create trigger billing_customers_guard before update or delete on private.billing_customers
  for each row execute function private.guard_billing_customer();
create trigger billing_customers_no_truncate before truncate on private.billing_customers
  for each statement execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- Cada salida a pagar.

create table private.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  livemode boolean not null,
  plan public.subscription_plan not null,
  lookup_key text not null,
  amount_cents bigint not null,               -- el monto que se mostró, en centavos de MXN, IVA incluido
  currency text not null default 'MXN',
  next_charge_at timestamptz not null,        -- la fecha del siguiente cobro que se mostró
  expires_at timestamptz not null,            -- lo que se le manda a Stripe: la hora en que la vence
  return_to text not null,                    -- a dónde vuelve PA-32 cuando llega el aviso
  consent_id uuid not null references public.consents (id),
  state private.checkout_state not null default 'reserved',
  creating_at timestamptz,
  session_id text,
  url text,
  subscription_id text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint checkout_sessions_amount check (amount_cents > 0),
  constraint checkout_sessions_currency check (currency = 'MXN'),
  constraint checkout_sessions_lookup_key check (lookup_key ~ '^plataforma_(monthly|annual)_[1-9][0-9]*_mxn$'),
  constraint checkout_sessions_return_to check (length(return_to) <= 200 and return_to ~ '^/([A-Za-z0-9_.~/?=&%+-]*)$' and return_to !~ '^//'),
  constraint checkout_sessions_session_shape check (session_id is null or session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$'),
  constraint checkout_sessions_url_shape check (url is null or (url ~ '^https://checkout\.stripe\.com/' and length(url) <= 2000)),
  constraint checkout_sessions_subscription_shape check (subscription_id is null or subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  constraint checkout_sessions_session_with_url check ((session_id is null) = (url is null)),
  constraint checkout_sessions_open_has_session check (state <> 'open' or session_id is not null),
  constraint checkout_sessions_completed_has_subscription check ((state = 'completed') = (subscription_id is not null)),
  constraint checkout_sessions_closed_at check ((state in ('reserved', 'creating', 'open')) = (closed_at is null))
);
comment on table private.checkout_sessions is 'Cada salida a la página de pago de Stripe (T-302): lo que se mostró, lo que va a Stripe y cómo terminó. Una abierta por cuenta.';
create unique index checkout_sessions_one_open_uq on private.checkout_sessions (profile_id) where state in ('reserved', 'creating', 'open');
create unique index checkout_sessions_session_uq on private.checkout_sessions (session_id) where session_id is not null;
-- Lo completado, que `checkout_blocking` mira en cada salida y en cada vista de PA-04.
create index checkout_sessions_completed_idx on private.checkout_sessions (profile_id, subscription_id) where state = 'completed';
alter table private.checkout_sessions enable row level security;
revoke all on table private.checkout_sessions from public, anon, authenticated, service_role, app_service;

-- Nace reservada; lo reservado no cambia; los pasos van en un solo sentido, y lo cerrado no se mueve, salvo lo vencido por el reloj, que se corrige con la
-- palabra de Stripe (la completó o la venció). Nada se borra.
create function private.guard_checkout_session() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%.%: a checkout is never deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'reserved' or new.creating_at is not null or new.session_id is not null or new.subscription_id is not null then
      raise exception '%.%: a checkout is born reserved', tg_table_schema, tg_table_name using errcode = '42501';
    end if;
    new.created_at := pg_catalog.now();
    return new;
  end if;
  if (new.id, new.profile_id, new.livemode, new.plan, new.lookup_key, new.amount_cents, new.currency, new.next_charge_at, new.expires_at,
      new.return_to, new.consent_id, new.created_at)
     is distinct from
     (old.id, old.profile_id, old.livemode, old.plan, old.lookup_key, old.amount_cents, old.currency, old.next_charge_at, old.expires_at,
      old.return_to, old.consent_id, old.created_at) then
    raise exception '%.%: what was reserved does not change', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if old.state not in ('reserved', 'creating', 'open')
     and not (old.state = 'lapsed' and old.creating_at is not null and new.state in ('completed', 'expired')) then
    raise exception '%.%: a closed checkout does not change', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if old.session_id is not null and (new.session_id is distinct from old.session_id or new.url is distinct from old.url) then
    raise exception '%.%: a recorded session does not change', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'reserved' and new.state in ('creating', 'abandoned', 'lapsed'))
       or (old.state = 'creating' and new.state in ('open', 'completed', 'expired', 'abandoned', 'lapsed'))
       or (old.state = 'open' and new.state in ('completed', 'expired', 'lapsed'))
       or (old.state = 'lapsed' and old.creating_at is not null and new.state in ('completed', 'expired'))) then
    raise exception '%.%: a checkout cannot go from % to %', tg_table_schema, tg_table_name, old.state, new.state using errcode = '42501';
  end if;
  if new.state in ('completed', 'expired', 'abandoned', 'lapsed') then
    new.closed_at := pg_catalog.now();
  end if;
  return new;
end
$$;
revoke all on function private.guard_checkout_session() from public;
create trigger checkout_sessions_guard before insert or update or delete on private.checkout_sessions
  for each row execute function private.guard_checkout_session();
create trigger checkout_sessions_no_truncate before truncate on private.checkout_sessions
  for each statement execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- Ayudas, que nadie de la aplicación ejecuta.

-- El monto vigente de un plan, en centavos, del parámetro; nulo si no tiene un entero positivo.
create function private.checkout_amount(p_plan public.subscription_plan, p_at timestamptz) returns bigint
language sql stable set search_path = ''
as $$
  select case when pg_catalog.jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^[1-9][0-9]{0,11}$' then (v #>> '{}')::bigint end
  from (select private.parameter_value(case p_plan when 'monthly' then 'PRECIO_MENSUAL' else 'PRECIO_ANUAL' end, p_at) as v) x
$$;
revoke all on function private.checkout_amount(public.subscription_plan, timestamptz) from public;

-- La clave del precio en Stripe para ese plan y ese monto: quien opera crea el Price con ella antes de que rija el parámetro (OP-13).
create function private.checkout_lookup_key(p_plan public.subscription_plan, p_amount bigint) returns text
language sql immutable set search_path = ''
as $$ select 'plataforma_' || p_plan::text || '_' || p_amount::text || '_mxn' $$;
revoke all on function private.checkout_lookup_key(public.subscription_plan, bigint) from public;

-- El siguiente cobro, como lo cuenta Stripe: en UTC, un mes o un año después, y si ese día no existe, el último del mes.
create function private.checkout_next_charge(p_plan public.subscription_plan, p_at timestamptz) returns timestamptz
language sql immutable set search_path = ''
as $$
  select ((p_at at time zone 'UTC') + case p_plan when 'monthly' then interval '1 month' else interval '1 year' end) at time zone 'UTC'
$$;
revoke all on function private.checkout_next_charge(public.subscription_plan, timestamptz) from public;

-- Un pago en curso: una suscripción viva; una de Stripe que no da acceso todavía y que Stripe no dio por terminada (vencida, cancelada o sin pagar); o una
-- salida que Stripe completó y cuya suscripción todavía no llegó con su aviso, o llegó sin terminar. Sin plazo: es alguien que pagó y cuyo aviso no se aplicó,
-- y dejarlo pagar otra vez le cobraría dos veces (si el aviso no llega nunca, lo resuelve soporte, T-307).
create function private.checkout_blocking(p_profile uuid) returns boolean
language sql stable set search_path = ''
as $$
  select exists (
           select 1 from public.subscriptions s
           where s.profile_id = p_profile
             and (s.status in ('active', 'in_grace')
                  or (s.status = 'pending' and s.provider = 'stripe'
                      and coalesce(s.provider_status, '') not in ('canceled', 'incomplete_expired', 'unpaid'))))
      or exists (
           select 1 from private.checkout_sessions c
           where c.profile_id = p_profile and c.state = 'completed'
             and not exists (
               select 1 from public.subscriptions s
               where s.provider = 'stripe' and s.provider_subscription_id = c.subscription_id
                 and (s.status in ('canceled', 'expired', 'refunded')
                      or (s.status = 'pending' and coalesce(s.provider_status, '') in ('canceled', 'incomplete_expired', 'unpaid')))))
$$;
revoke all on function private.checkout_blocking(uuid) from public;

-- Una salida como la ve el servidor.
create function private.checkout_row(s private.checkout_sessions) returns jsonb
language sql immutable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', s.id, 'plan', s.plan, 'livemode', s.livemode, 'lookup_key', s.lookup_key, 'amount_cents', s.amount_cents,
    'next_charge_at', s.next_charge_at, 'expires_at', s.expires_at, 'return_to', s.return_to, 'state', s.state,
    'session_id', s.session_id, 'url', s.url)
$$;
revoke all on function private.checkout_row(private.checkout_sessions) from public;

-- ---------------------------------------------------------------------------------------
-- Las puertas, solo del servidor.

-- Lo que PA-04 muestra, también al visitante: los planes con su monto vigente, la clave de su precio y la fecha del siguiente cobro; el texto del cobro
-- recurrente que rige (nulo si no hay); y la política de reembolsos y sus días.
create function private.checkout_offer() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_plans jsonb := '[]'::jsonb;
  v_plan public.subscription_plan;
  v_amount bigint;
  v_recurring uuid := private.current_legal_document('recurring_charge_consent');
begin
  foreach v_plan in array array['monthly', 'annual']::public.subscription_plan[] loop
    v_amount := private.checkout_amount(v_plan, pg_catalog.now());
    if v_amount is not null then
      v_plans := v_plans || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'plan', v_plan, 'amount_cents', v_amount, 'lookup_key', private.checkout_lookup_key(v_plan, v_amount),
        'next_charge_at', private.checkout_next_charge(v_plan, pg_catalog.now())));
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'plans', v_plans,
    'recurring', (select pg_catalog.jsonb_build_object('id', d.id, 'version', d.version, 'title', d.title, 'body', d.body)
                  from public.legal_documents d where d.id = v_recurring),
    'refund_policy', private.current_legal_document('refund_policy'),
    'refund_days', private.parameter_value('VENTANA_REEMBOLSO_DIAS'));
end
$$;

-- Lo que PA-04 sabe de quien mira: si tiene un pago en curso y su salida abierta.
create function private.checkout_standing() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_open private.checkout_sessions;
begin
  if v_actor is null then
    return null;
  end if;
  select * into v_open from private.checkout_sessions s
  where s.profile_id = v_actor and s.state in ('reserved', 'creating', 'open') and s.expires_at > pg_catalog.now();
  return pg_catalog.jsonb_build_object(
    'blocking', private.checkout_blocking(v_actor),
    'open', case when v_open.id is null then null else private.checkout_row(v_open) end);
end
$$;

-- Reservar la salida a pagar, como la persona (`private.actor_id()`, sin parámetro de cuenta). Respuestas: `not_allowed` (con `reason`: `no_actor`,
-- `suspended`, `email_unverified`), `invalid`, `in_progress`, `unavailable` (sin el monto o sin el texto vigente), `changed` (lo que se vio ya no rige),
-- `reuse` (la misma abierta), `open_other` (hay otra abierta: se vence primero) y `reserved`. Las dos últimas y `reuse` traen la salida y el cliente.
create function private.checkout_begin(p_plan public.subscription_plan, p_amount_seen bigint, p_document_seen uuid, p_livemode boolean,
                                       p_return_to text, p_ip inet, p_user_agent text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_status public.profile_status;
  v_verified boolean;
  v_amount bigint;
  v_document uuid;
  v_open private.checkout_sessions;
  v_row private.checkout_sessions;
  v_consent uuid;
  v_customer text;
begin
  if v_actor is null then
    return pg_catalog.jsonb_build_object('answer', 'not_allowed', 'reason', 'no_actor');
  end if;
  if p_plan is null or p_livemode is null or p_return_to is null or length(p_return_to) > 200
     or p_return_to !~ '^/([A-Za-z0-9_.~/?=&%+-]*)$' or p_return_to ~ '^//' then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  -- Una salida a la vez por cuenta: dos peticiones (dos pestañas, un doble clic) se esperan una a la otra.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('checkout:' || v_actor::text, 0));

  select p.status, coalesce(u.email_confirmed_at is not null, false) into v_status, v_verified
  from public.profiles p left join auth.users u on u.id = p.id
  where p.id = v_actor;
  if v_status is null then
    return pg_catalog.jsonb_build_object('answer', 'not_allowed', 'reason', 'no_actor');
  elsif v_status <> 'active' then
    return pg_catalog.jsonb_build_object('answer', 'not_allowed', 'reason', 'suspended');
  elsif not v_verified then
    return pg_catalog.jsonb_build_object('answer', 'not_allowed', 'reason', 'email_unverified');
  end if;
  if private.checkout_blocking(v_actor) then
    return pg_catalog.jsonb_build_object('answer', 'in_progress');
  end if;

  v_amount := private.checkout_amount(p_plan, pg_catalog.now());
  v_document := private.current_legal_document('recurring_charge_consent');
  if v_amount is null or v_document is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  if p_amount_seen is distinct from v_amount or p_document_seen is distinct from v_document then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;

  -- Lo que pasó de su vencimiento ya lo venció Stripe: se cierra por el reloj, con cinco minutos de margen para un pago que iba en camino al vencer o un
  -- reloj desfasado. Si Stripe la completó, lo dice después (`checkout_close`), y una vencida por el reloj se corrige.
  update private.checkout_sessions s set state = 'lapsed'
  where s.profile_id = v_actor and s.state in ('reserved', 'creating', 'open') and s.expires_at <= pg_catalog.now() - interval '5 minutes';

  select b.customer_id into v_customer from private.billing_customers b where b.profile_id = v_actor and b.livemode = p_livemode;
  select * into v_open from private.checkout_sessions s where s.profile_id = v_actor and s.state in ('reserved', 'creating', 'open');
  if v_open.id is not null then
    -- Vencida, dentro del margen: Stripe ya no la cobra, pero un pago pudo ir en camino. Se espera.
    if v_open.expires_at <= pg_catalog.now() then
      return pg_catalog.jsonb_build_object('answer', 'in_progress');
    end if;
    -- La misma salida solo si es del mismo plan, monto y modo, y su consentimiento es del texto que se vio: si no, la evidencia sería de otro texto.
    if v_open.plan = p_plan and v_open.amount_cents = v_amount and v_open.livemode = p_livemode
       and (select c.legal_document_id from public.consents c where c.id = v_open.consent_id) = v_document then
      return pg_catalog.jsonb_build_object('answer', 'reuse', 'checkout', private.checkout_row(v_open), 'customer', v_customer);
    end if;
    return pg_catalog.jsonb_build_object('answer', 'open_other', 'checkout', private.checkout_row(v_open), 'customer', v_customer);
  end if;

  insert into public.consents (profile_id, legal_document_id, origin, ip, user_agent)
  values (v_actor, v_document, 'checkout', p_ip, left(p_user_agent, 1000))
  returning id into v_consent;
  insert into private.billing_customers (profile_id, livemode) values (v_actor, p_livemode) on conflict do nothing;
  insert into private.checkout_sessions (profile_id, livemode, plan, lookup_key, amount_cents, next_charge_at, expires_at, return_to, consent_id)
  values (v_actor, p_livemode, p_plan, private.checkout_lookup_key(p_plan, v_amount), v_amount, private.checkout_next_charge(p_plan, pg_catalog.now()),
          pg_catalog.now() + interval '1 hour', p_return_to, v_consent)
  returning * into v_row;
  return pg_catalog.jsonb_build_object('answer', 'reserved', 'checkout', private.checkout_row(v_row), 'customer', v_customer);
end
$$;

-- Antes de pedírsela a Stripe: de reservada a creando, y lo reservado para mandarlo tal cual. Un reintento recibe lo mismo. Respuestas: `creating`, `open`
-- (ya tiene su sesión), `closed`, `stale` (reservada hace tanto que Stripe ya no aceptaría su vencimiento: al menos 30 minutos desde que se crea; se abandona),
-- `not_found` y `not_allowed`.
create function private.checkout_creating(p_checkout uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_row private.checkout_sessions;
begin
  if v_actor is null then
    return pg_catalog.jsonb_build_object('answer', 'not_allowed');
  end if;
  select * into v_row from private.checkout_sessions s where s.id = p_checkout and s.profile_id = v_actor for update;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  elsif v_row.state = 'open' then
    return pg_catalog.jsonb_build_object('answer', 'open', 'checkout', private.checkout_row(v_row));
  elsif v_row.state not in ('reserved', 'creating') then
    return pg_catalog.jsonb_build_object('answer', 'closed');
  elsif v_row.state = 'reserved' then
    if v_row.expires_at < pg_catalog.now() + interval '31 minutes' then
      return pg_catalog.jsonb_build_object('answer', 'stale');
    end if;
    update private.checkout_sessions s set state = 'creating', creating_at = pg_catalog.now() where s.id = v_row.id returning * into v_row;
  end if;
  return pg_catalog.jsonb_build_object('answer', 'creating', 'checkout', private.checkout_row(v_row));
end
$$;

-- Anotar el cliente que creó Stripe para quien actúa. Respuestas: `recorded`, `conflict` (ya tiene otro, o es de otra cuenta), `invalid`, `not_found` (sin
-- reserva) y `not_allowed`.
create function private.checkout_customer_record(p_livemode boolean, p_customer text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_current text;
begin
  if v_actor is null then
    return 'not_allowed';
  end if;
  if p_livemode is null or p_customer is null or p_customer !~ '^cus_[A-Za-z0-9]{1,250}$' then
    return 'invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('checkout:' || v_actor::text, 0));
  select b.customer_id into v_current from private.billing_customers b
  where b.profile_id = v_actor and b.livemode = p_livemode for update;
  if not found then
    return 'not_found';
  elsif v_current = p_customer then
    return 'recorded';
  elsif v_current is not null then
    return 'conflict';
  elsif exists (select 1 from private.billing_customers b where b.livemode = p_livemode and b.customer_id = p_customer) then
    return 'conflict';
  end if;
  -- Dos cuentas que anotan el mismo cliente a la vez: la segunda choca con el índice único, y es lo mismo que «es de otra cuenta».
  begin
    update private.billing_customers b set customer_id = p_customer, recorded_at = pg_catalog.now()
    where b.profile_id = v_actor and b.livemode = p_livemode;
  exception when unique_violation then
    return 'conflict';
  end;
  return 'recorded';
end
$$;

-- Anotar la sesión que creó Stripe: de creando a abierta. Respuestas: `recorded`, `conflict` (ya tiene otra), `invalid`, `not_found` y `not_allowed` (no está
-- creando).
create function private.checkout_session_record(p_checkout uuid, p_session text, p_url text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_row private.checkout_sessions;
begin
  if v_actor is null then
    return 'not_allowed';
  end if;
  if p_session is null or p_url is null or p_session !~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$'
     or p_url !~ '^https://checkout\.stripe\.com/' or length(p_url) > 2000 then
    return 'invalid';
  end if;
  select * into v_row from private.checkout_sessions s where s.id = p_checkout and s.profile_id = v_actor for update;
  if v_row.id is null then
    return 'not_found';
  elsif v_row.session_id = p_session then
    return 'recorded';
  elsif v_row.session_id is not null then
    return 'conflict';
  elsif (p_session ~ '^cs_live_') <> v_row.livemode then
    return 'invalid';
  elsif v_row.state <> 'creating' then
    return 'not_allowed';
  end if;
  -- Una sesión que ya anotó otra salida choca con su índice único: no es de esta.
  begin
    update private.checkout_sessions s set state = 'open', session_id = p_session, url = p_url where s.id = v_row.id;
  exception when unique_violation then
    return 'conflict';
  end;
  return 'recorded';
end
$$;

-- Cerrar una salida con la palabra de Stripe: `abandoned` (nunca se le pidió, o rechazó crearla), `expired` (la venció) o `completed` (se pagó, con su
-- suscripción). Una vencida por el reloj se corrige así. La cierra la persona, y solo la suya: ningún trabajo la cierra todavía. Respuestas: `closed`,
-- `already_closed`, `not_allowed` (ese paso no se puede), `invalid` y `not_found`.
create function private.checkout_close(p_checkout uuid, p_state text, p_subscription text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_row private.checkout_sessions;
begin
  if v_actor is null then
    return 'not_allowed';
  end if;
  if p_state is null or p_state not in ('abandoned', 'expired', 'completed')
     or (p_state = 'completed') <> (p_subscription is not null)
     or (p_subscription is not null and p_subscription !~ '^sub_[A-Za-z0-9]{1,250}$') then
    return 'invalid';
  end if;
  select * into v_row from private.checkout_sessions s
  where s.id = p_checkout and s.profile_id = v_actor for update;
  if v_row.id is null then
    return 'not_found';
  -- Una vencida por el reloj se corrige solo si alguna vez se pidió a Stripe: una que nunca salió de reservada, Stripe no la conoce.
  elsif v_row.state not in ('reserved', 'creating', 'open')
        and not (v_row.state = 'lapsed' and v_row.creating_at is not null and p_state in ('expired', 'completed')) then
    return 'already_closed';
  elsif not ((p_state = 'abandoned' and v_row.state in ('reserved', 'creating'))
             or (p_state in ('expired', 'completed') and v_row.state in ('creating', 'open', 'lapsed'))) then
    return 'not_allowed';
  end if;
  update private.checkout_sessions s set state = p_state::private.checkout_state, subscription_id = p_subscription where s.id = v_row.id;
  return 'closed';
end
$$;

-- Lo que PA-32 lee: si la sesión es de quien mira, cómo va, a dónde vuelve, y si su suscripción ya está viva. Nunca da acceso: el acceso es de la regla única.
create function private.checkout_status(p_session text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_row private.checkout_sessions;
begin
  if v_actor is null or p_session is null then
    return pg_catalog.jsonb_build_object('mine', false);
  end if;
  select * into v_row from private.checkout_sessions s where s.session_id = p_session and s.profile_id = v_actor;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('mine', false);
  end if;
  return private.checkout_row(v_row) || pg_catalog.jsonb_build_object(
    'mine', true,
    'subscription_id', v_row.subscription_id,
    'live', exists (select 1 from public.subscriptions s
                    where s.provider = 'stripe' and s.provider_subscription_id = v_row.subscription_id and s.profile_id = v_actor
                      and s.status in ('active', 'in_grace')));
end
$$;

revoke all on function private.checkout_offer(), private.checkout_standing(),
  private.checkout_begin(public.subscription_plan, bigint, uuid, boolean, text, inet, text), private.checkout_creating(uuid),
  private.checkout_customer_record(boolean, text), private.checkout_session_record(uuid, text, text), private.checkout_close(uuid, text, text),
  private.checkout_status(text) from public;
grant execute on function private.checkout_offer(), private.checkout_standing(),
  private.checkout_begin(public.subscription_plan, bigint, uuid, boolean, text, inet, text), private.checkout_creating(uuid),
  private.checkout_customer_record(boolean, text), private.checkout_session_record(uuid, text, text), private.checkout_close(uuid, text, text),
  private.checkout_status(text) to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante de la salida a pagar (carril A).

create function private.schema_violations_checkout()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tables (table_name) as (
    values ('private.checkout_sessions'), ('private.billing_customers')),
  doors (name, signature) as (
    values ('checkout_offer', 'private.checkout_offer()'),
           ('checkout_standing', 'private.checkout_standing()'),
           ('checkout_begin', 'private.checkout_begin(public.subscription_plan, bigint, uuid, boolean, text, inet, text)'),
           ('checkout_creating', 'private.checkout_creating(uuid)'),
           ('checkout_customer_record', 'private.checkout_customer_record(boolean, text)'),
           ('checkout_session_record', 'private.checkout_session_record(uuid, text, text)'),
           ('checkout_close', 'private.checkout_close(uuid, text, text)'),
           ('checkout_status', 'private.checkout_status(text)')),
  helpers (name, signature) as (
    values ('checkout_amount', 'private.checkout_amount(public.subscription_plan, timestamptz)'),
           ('checkout_lookup_key', 'private.checkout_lookup_key(public.subscription_plan, bigint)'),
           ('checkout_next_charge', 'private.checkout_next_charge(public.subscription_plan, timestamptz)'),
           ('checkout_blocking', 'private.checkout_blocking(uuid)'),
           ('checkout_row', 'private.checkout_row(private.checkout_sessions)'),
           ('guard_checkout_session', 'private.guard_checkout_session()'),
           ('guard_billing_customer', 'private.guard_billing_customer()'))
  select 'checkout table privilege for ' || r.rolname, t.table_name
  from app_roles r cross join tables t
  where pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, references')
  union all
  select 'checkout table without row security', t.table_name
  from tables t
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t.table_name::regclass)
  union all
  select 'checkout door missing or wrong: ' || d.name, d.name
  from doors d
  where pg_catalog.to_regprocedure(d.signature) is null
     or not coalesce((select p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']
                      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(d.signature)), false)
     or not pg_catalog.has_function_privilege('app_service', d.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', d.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', d.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', d.signature, 'execute')
  union all
  select 'checkout helper reachable: ' || h.name, h.name
  from helpers h
  where pg_catalog.to_regprocedure(h.signature) is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(h.signature))
     or pg_catalog.has_function_privilege('app_service', h.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', h.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', h.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', h.signature, 'execute')
  union all
  select 'checkout trigger missing: ' || t.name, t.table_name
  from (values ('checkout_sessions_guard', 'private.checkout_sessions', '%guard_checkout_session%'),
               ('checkout_sessions_no_truncate', 'private.checkout_sessions', '%reject_mutation%'),
               ('billing_customers_guard', 'private.billing_customers', '%guard_billing_customer%'),
               ('billing_customers_no_truncate', 'private.billing_customers', '%reject_mutation%')) t (name, table_name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = t.table_name::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  select 'checkout without one open per account', 'private.checkout_sessions'
  where not exists (select 1 from pg_catalog.pg_indexes i
                    where i.schemaname = 'private' and i.indexname = 'checkout_sessions_one_open_uq'
                      and i.indexdef like '%UNIQUE%(profile_id)%reserved%creating%open%')
  union all
  select 'checkout begin without its order', 'checkout_begin'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.checkout_begin(public.subscription_plan, bigint, uuid, boolean, text, inet, text)'))
                     like '%v_actor uuid := private.actor_id()%pg_advisory_xact_lock%''checkout:''%private.checkout_blocking(v_actor)%p_amount_seen is distinct from v_amount%insert into public.consents%insert into private.checkout_sessions%', false)
$$;
revoke all on function private.schema_violations_checkout() from public;
