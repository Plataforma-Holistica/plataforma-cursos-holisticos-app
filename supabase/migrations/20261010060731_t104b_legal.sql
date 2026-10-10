-- T-104 · Textos legales con versión y consentimientos (RF-108, RF-713).
-- Esquema de backend §5.8, §6.4, §6.5 y §7. Segunda entrega de T-104: el registro guarda
-- qué versión de qué texto aceptó cada persona.
--
-- La política que deja leer a los maestros sus textos (§6.5) no viene aquí: nombra
-- private.current_teacher_id(), que llega con la tabla de maestros.

create type public.legal_doc_type as enum (
  'terms', 'student_privacy_notice', 'teacher_privacy_notice', 'community_policy',
  'refund_policy', 'teacher_agreement', 'license_annex',
  'course_history_consent', 'recurring_charge_consent');
create type public.consent_action as enum ('granted', 'withdrawn');

-- ---------------------------------------------------------------------------------------
-- Textos legales (5.8). Un libro: una versión publicada no cambia.

create table public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  doc_type public.legal_doc_type not null,
  version integer not null,                   -- 0 es borrador local; las publicadas empiezan en 1
  title text not null,
  body text not null,                         -- el texto completo, tal como se publicó
  body_sha256 bytea not null,                 -- la calcula la base a partir de body, no quien inserta
  effective_from timestamptz not null,
  requires_reconsent boolean not null default false,   -- términos y privacidad disparan RF-108
  published_by uuid references public.profiles (id),   -- lo llena la base con quien actúa; nulo si fue el sistema
  published_at timestamptz not null default now(),     -- lo llena la base
  constraint legal_documents_version_uq unique (doc_type, version),
  constraint legal_documents_version_not_negative check (version >= 0),
  constraint legal_documents_hash_length check (octet_length(body_sha256) = 32)
);
comment on table public.legal_documents is 'Cada versión de cada texto legal, con su huella y su vigencia (RF-713). Solo inserción.';
-- Versión vigente de un documento: private.current_legal_document().
create index legal_documents_current_idx on public.legal_documents (doc_type, effective_from desc);

-- La única definición de «vigente»: la de mayor vigencia que ya empezó. La usan el guardián
-- de consents y los servicios de cuenta, para que no haya dos respuestas distintas.
create function private.current_legal_document(
  p_doc_type public.legal_doc_type, p_at timestamptz default now()) returns uuid
language sql stable security definer set search_path = ''
as $$
  select d.id
  from public.legal_documents d
  where d.doc_type = p_doc_type and d.effective_from <= p_at
  order by d.effective_from desc, d.version desc
  limit 1
$$;

grant execute on function private.current_legal_document(public.legal_doc_type, timestamptz) to app_service;

-- La huella, el autor y la fecha los escribe la base. Y las reglas de una versión:
--   · la 0 es un borrador, que solo carga el dueño de la tabla, declarado como sistema y
--     con el ajuste que pone el guion de borradores (scripts/db-legal-drafts.mjs). El
--     servidor puede poner cualquier ajuste, así que el ajuste solo no basta: por eso se
--     mira además quién ejecuta, y por eso esta función no es "security definer";
--   · de la 1 en adelante las versiones crecen, ninguna rige hacia atrás ni antes que la
--     anterior, y desde la 2 la publica una persona. De la vigente depende a quién se le
--     vuelve a pedir el consentimiento (RF-108), y un libro no se corrige después.
create function private.guard_legal_document() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
  v_last_version integer;
  v_last_from timestamptz;
begin
  new.body_sha256 := pg_catalog.sha256(pg_catalog.convert_to(new.body, 'UTF8'));
  new.published_by := private.actor_id();
  new.published_at := pg_catalog.now();

  if new.version = 0 then
    select pg_catalog.pg_get_userbyid(c.relowner) into v_owner
    from pg_catalog.pg_class c where c.oid = tg_relid;
    if current_user::name <> v_owner
       or not private.actor_is_system()
       or coalesce(pg_catalog.current_setting('app.legal_drafts', true), '') <> 'on' then
      raise exception '%.%: version 0 is a local draft and is loaded only by the drafts script',
        tg_table_schema, tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;

  select max(d.version), max(d.effective_from) into v_last_version, v_last_from
  from public.legal_documents d where d.doc_type = new.doc_type;
  if v_last_version is not null and new.version <= v_last_version then
    raise exception '%.%: version % of % is not after version %',
      tg_table_schema, tg_table_name, new.version, new.doc_type, v_last_version using errcode = '23514';
  end if;
  if new.effective_from < new.published_at then
    raise exception '%.%: a published version cannot take effect in the past',
      tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  if v_last_from is not null and new.effective_from <= v_last_from then
    raise exception '%.%: a new version must take effect after the previous one',
      tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  if new.version >= 2 and new.published_by is null then
    raise exception '%.%: from version 2 on, a person publishes the document',
      tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  return new;
end
$$;

alter table public.legal_documents enable row level security;

-- Lo vigente y público lo lee cualquiera, también sin sesión. Por columnas: quién publicó
-- un texto es el identificador de un administrador y no sale por la API de datos.
grant select (id, doc_type, version, title, body, body_sha256, effective_from, requires_reconsent, published_at)
  on public.legal_documents to anon, authenticated;
-- El servidor: es un libro, solo leer e insertar.
grant select, insert on public.legal_documents to app_service;

create policy legal_documents_public_select on public.legal_documents
  for select to anon, authenticated
  using (effective_from <= now() and doc_type in (
    'terms', 'student_privacy_notice', 'community_policy', 'refund_policy',
    'course_history_consent', 'recurring_charge_consent'));
create policy legal_documents_config_select on public.legal_documents
  for select to authenticated
  using ((select private.has_capability('config'::public.capability)));

-- Los disparadores "before" de una tabla corren en orden alfabético: primero quién, después qué.
create trigger legal_documents_actor before insert on public.legal_documents
  for each row execute function private.guard_config_actor();
create trigger legal_documents_fill before insert on public.legal_documents
  for each row execute function private.guard_legal_document();

create trigger ledger_no_update_delete before update or delete on public.legal_documents
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.legal_documents
  for each statement execute function private.reject_mutation();

-- Auditoría (7.4): publicar deja rastro, con la huella y sin el texto.
create trigger audit_changes after insert or update or delete on public.legal_documents
  for each row execute function private.audit_row_change('config', 'body');

-- ---------------------------------------------------------------------------------------
-- Consentimientos (5.8). Qué versión aceptó o retiró cada cuenta, cuándo y desde dónde.

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  legal_document_id uuid not null references public.legal_documents (id),
  action public.consent_action not null default 'granted',
  origin text not null,                       -- desde qué pantalla
  ip inet,                                    -- se vacía al eliminar la cuenta
  user_agent text,                            -- se vacía al eliminar la cuenta
  occurred_at timestamptz not null default now(),   -- lo llena la base
  constraint consents_origin_known check (origin in (
    'signup', 'login_prompt', 'checkout', 'teacher_invitation', 'admin_invitation',
    'course_submission', 'account_settings', 'data_request'))
);
comment on table public.consents is 'Qué versión de qué texto aceptó o retiró cada cuenta (RF-108). Solo inserción; al eliminar la cuenta se vacían la IP y el navegador.';
-- Consentimientos de una cuenta, y "¿ya aceptó la versión vigente?" en cada entrada con sesión.
create index consents_profile_idx on public.consents (profile_id, legal_document_id, occurred_at desc);

-- Un consentimiento es evidencia: lo registra la propia persona (el servidor declara por
-- quién actúa, con el token que verificó), sobre el texto vigente, con la hora de la base.
-- Retirar es una fila nueva y puede apuntar a una versión anterior, que es la que se aceptó.
create function private.guard_consent() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_doc_type public.legal_doc_type;
begin
  if v_actor is null or v_actor <> new.profile_id then
    raise exception '%.%: a consent is recorded only by the person it belongs to',
      tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  new.occurred_at := pg_catalog.now();
  if new.action = 'granted' then
    select d.doc_type into v_doc_type from public.legal_documents d where d.id = new.legal_document_id;
    if v_doc_type is null
       or private.current_legal_document(v_doc_type) is distinct from new.legal_document_id then
      raise exception '%.%: a consent must point to the document in force',
        tg_table_schema, tg_table_name using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

-- Los argumentos son las columnas que pueden vaciarse. Es la puerta de la eliminación de cuentas.
create function private.allow_only_redaction() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_allowed text[] := tg_argv::text[];
  v_new jsonb;
  v_col text;
begin
  if tg_op = 'DELETE' then
    raise exception 'append-only ledger %.%: DELETE is not allowed', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  v_new := to_jsonb(new);
  if (to_jsonb(old) - v_allowed) is distinct from (v_new - v_allowed) then
    raise exception '%.%: only redaction of % is allowed', tg_table_schema, tg_table_name, v_allowed
      using errcode = '42501';
  end if;
  foreach v_col in array v_allowed loop
    if (v_new -> v_col) <> 'null'::jsonb then
      raise exception '%.%: % can only be set to null', tg_table_schema, tg_table_name, v_col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end
$$;

alter table public.consents enable row level security;

-- La persona lee los suyos, sin la IP ni el navegador: esos dos solo los lee el servidor.
grant select (id, profile_id, legal_document_id, action, origin, occurred_at)
  on public.consents to authenticated;
grant select, insert on public.consents to app_service;

create policy consents_self_select on public.consents
  for select to authenticated using (profile_id = (select auth.uid()));

create trigger consents_fill before insert on public.consents
  for each row execute function private.guard_consent();
create trigger consents_guard before update or delete on public.consents
  for each row execute function private.allow_only_redaction('ip', 'user_agent');
create trigger ledger_no_truncate before truncate on public.consents
  for each statement execute function private.reject_mutation();
