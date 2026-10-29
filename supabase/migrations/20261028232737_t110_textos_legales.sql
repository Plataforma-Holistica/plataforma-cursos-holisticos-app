-- T-110 · Publicar una versión de un texto legal desde PA-89 (RF-713, RF-108, FL-57; esquema §5.8).
-- Decisiones de Sergio del 2026-10-28: los textos provisionales siguen siendo los borradores de
-- versión 0 de local, y los del abogado entran como versión 1 por aquí; PA-89 publica nueve tipos
-- (los siete textos y los dos consentimientos); una versión nueva del consentimiento del historial
-- se vuelve a pedir.
--
-- Lo que cambia respecto a 20261010060731 (t104b_legal):
--   · el servidor ya no inserta en public.legal_documents: publica con
--     private.publish_legal_document(), que pasa la puerta de configuración con código reciente
--     (private.team_change_gate(), la de los parámetros), pone la versión, compara la que vio quien
--     publica y traduce el día de vigencia a la zona del periodo;
--   · el guardián decide quién vuelve a aceptar por el tipo de texto, no por lo que mande quien
--     inserta, y de la versión 1 en adelante solo deja insertar al dueño de la tabla (la función,
--     las migraciones y las pruebas): aunque el servidor recuperara el permiso, no publicaría por
--     fuera;
--   · dos lecturas para configuración: la tabla de PA-89 y el texto de una versión;
--   · el área `legal` del vigilante, del carril A.

-- ---------------------------------------------------------------------------------------
-- El guardián. Lo de antes, más dos reglas al principio: quién vuelve a aceptar sale del tipo, y
-- desde la versión 1 inserta solo el dueño.
--
-- Vuelven a aceptar (RF-108, RF-713): los términos, los dos avisos de privacidad y el
-- consentimiento del historial (decisión de Sergio del 2026-10-28). No: comunidad, reembolsos,
-- el contrato y el anexo (cada maestro conserva la versión que aceptó, H-40) y el cobro
-- recurrente, que se acepta en cada pago (T-302).

create or replace function private.guard_legal_document() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
  v_last_version integer;
begin
  new.body_sha256 := pg_catalog.sha256(pg_catalog.convert_to(new.body, 'UTF8'));
  new.published_by := private.actor_id();
  new.published_at := pg_catalog.now();
  new.requires_reconsent := new.doc_type in
    ('terms', 'student_privacy_notice', 'teacher_privacy_notice', 'course_history_consent');

  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner
  from pg_catalog.pg_class c where c.oid = tg_relid;

  if new.version = 0 then
    if current_user::name <> v_owner
       or not private.actor_is_system()
       or coalesce(pg_catalog.current_setting('app.legal_drafts', true), '') <> 'on' then
      raise exception '%.%: version 0 is a local draft and is loaded only by the drafts script',
        tg_table_schema, tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;

  if current_user::name <> v_owner then
    raise exception '%.%: from version 1 on, a document is published only through private.publish_legal_document',
      tg_table_schema, tg_table_name using errcode = '42501';
  end if;

  select max(d.version) into v_last_version
  from public.legal_documents d where d.doc_type = new.doc_type;
  if v_last_version is not null and new.version <= v_last_version then
    raise exception '%.%: version % of % is not after version %',
      tg_table_schema, tg_table_name, new.version, new.doc_type, v_last_version using errcode = '23514';
  end if;
  if new.effective_from < new.published_at then
    raise exception '%.%: a published version cannot take effect in the past',
      tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  if new.version >= 2 and new.published_by is null then
    raise exception '%.%: from version 2 on, a person publishes the document',
      tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  return new;
end
$$;

revoke insert on public.legal_documents from app_service;

-- ---------------------------------------------------------------------------------------
-- Publicar. Respuestas:
--   published (con id, version y effective_from), changed (con la versión que hay), invalid,
--   past, unavailable (falta ZONA_HORARIA_PERIODO), forbidden, needs_fresh_code.
--
-- Toma el candado del tipo antes que nada y no escribe antes de rechazar: un choque de candados
-- se puede reintentar. La versión vista se compara bajo el candado, en una función volátil y en
-- read committed: la segunda de dos publicaciones a la vez espera a la primera, ve su versión y
-- contesta changed. Quien no vio ninguna manda nulo; un borrador cuenta como la versión 0.
--
-- El día es de la zona del periodo (Ciudad de México): hoy rige al publicar (now() es la hora
-- que el guardián le pone a la publicación), un día futuro rige a su medianoche, uno pasado se
-- rechaza. A lo más a 366 días (decisión mía sin confirmar): más lejos es casi seguro un error,
-- y una versión programada no se cancela: la reemplaza otra más nueva con fecha anterior o igual.
-- El texto llega con saltos de línea, sin retornos de carro ni otros caracteres de control, de
-- hasta 200 000 caracteres (decisión mía sin confirmar).

create function private.publish_legal_document(
  p_doc_type text, p_title text, p_body text, p_day date, p_seen_version integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_type public.legal_doc_type;
  v_title text := pg_catalog.btrim(normalize(coalesce(p_title, ''), NFC));
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
  v_today date;
  v_effective timestamptz;
  v_last integer;
  v_id uuid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'legal document changes run in read committed' using errcode = '25000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('legal_document:' || coalesce(p_doc_type, ''), 0));

  v_gate := private.team_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('answer', v_gate);
  end if;

  -- El título: sin caracteres de control, ni los separadores de renglón y de párrafo, que [[:cntrl:]]
  -- incluye o no según la configuración regional de la base.
  if p_doc_type is null or not (p_doc_type = any (pg_catalog.enum_range(null::public.legal_doc_type)::text[]))
     or pg_catalog.char_length(v_title) not between 1 and 200 or v_title ~ '[[:cntrl:]]' or v_title ~ E'[\u2028\u2029]'
     or p_body is null or pg_catalog.btrim(p_body, E' \n\t') = '' or pg_catalog.char_length(p_body) > 200000
     or p_body ~ E'[\\x01-\\x08\\x0b-\\x1f\\x7f]'
     or p_day is null then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  v_type := p_doc_type::public.legal_doc_type;

  if v_zone is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  v_today := (pg_catalog.now() at time zone v_zone)::date;
  if p_day < v_today then
    return pg_catalog.jsonb_build_object('answer', 'past');
  end if;
  if p_day > v_today + 366 then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  v_effective := case when p_day = v_today then pg_catalog.now() else p_day::timestamp at time zone v_zone end;

  select max(d.version) into v_last from public.legal_documents d where d.doc_type = v_type;
  if v_last is distinct from p_seen_version then
    return pg_catalog.jsonb_build_object('answer', 'changed', 'version', v_last);
  end if;

  insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values (v_type, coalesce(v_last, 0) + 1, v_title, p_body, v_effective)
  returning id into v_id;
  return pg_catalog.jsonb_build_object('answer', 'published', 'id', v_id,
    'version', coalesce(v_last, 0) + 1, 'effective_from', v_effective);
end
$$;

-- ---------------------------------------------------------------------------------------
-- La tabla de PA-89. Nula si quien actúa no pasa la puerta del equipo con configuración: una
-- sola función, para que «no pasas» no se vea como «no hay nada». No pide el código reciente:
-- leer no cambia nada; dice si lo es (`fresh_code`), para que la pantalla ofrezca publicar.
--
-- Los nueve tipos, en el orden del tipo enumerado, cada uno con su última versión y todas sus
-- versiones (de la más nueva a la más vieja), sin el texto. El estado de cada versión:
--   current     la vigente (private.current_legal_document(), la única definición);
--   superseded  una más nueva rige desde antes o desde el mismo instante: nunca regirá, o no
--               rigió nunca;
--   scheduled   rige más adelante;
--   previous    rigió y ya no.

create function private.legal_documents_admin() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
begin
  if private.actor_id() is null or not private.actor_has_capability('config') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.team_change_gate() is null,
    'today', case when v_zone is null then null else (pg_catalog.now() at time zone v_zone)::date end,
    'documents', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'doc_type', t.doc_type::text,
               'last_version', (select max(d.version) from public.legal_documents d where d.doc_type = t.doc_type),
               'versions', coalesce((
                 select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'id', d.id, 'version', d.version, 'title', d.title,
                          'effective_from', d.effective_from, 'published_at', d.published_at,
                          'body_sha256', pg_catalog.encode(d.body_sha256, 'hex'), 'is_draft', d.version = 0,
                          'state', case
                            when d.id = private.current_legal_document(t.doc_type) then 'current'
                            when exists (select 1 from public.legal_documents w
                                         where w.doc_type = d.doc_type and w.version > d.version
                                           and w.effective_from <= d.effective_from) then 'superseded'
                            when d.effective_from > pg_catalog.now() then 'scheduled'
                            else 'previous' end)
                        order by d.version desc)
                 from public.legal_documents d where d.doc_type = t.doc_type), '[]'::jsonb))
             order by t.ord)
      from unnest(pg_catalog.enum_range(null::public.legal_doc_type)) with ordinality as t (doc_type, ord)));
end
$$;

-- El texto de una versión, para verla desde PA-89 («Ver versiones anteriores»). Nula sin
-- configuración, como la tabla; `document` nulo si no existe.
create function private.legal_document_admin(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('config') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.team_change_gate() is null,
    'document', (
      select pg_catalog.jsonb_build_object(
               'id', d.id, 'doc_type', d.doc_type::text, 'version', d.version, 'title', d.title,
               'body', d.body, 'effective_from', d.effective_from, 'published_at', d.published_at,
               'body_sha256', pg_catalog.encode(d.body_sha256, 'hex'))
      from public.legal_documents d where d.id = p_id));
end
$$;

revoke all on function private.publish_legal_document(text, text, text, date, integer) from public;
revoke all on function private.legal_documents_admin() from public;
revoke all on function private.legal_document_admin(uuid) from public;
grant execute on function
  private.publish_legal_document(text, text, text, date, integer),
  private.legal_documents_admin(),
  private.legal_document_admin(uuid)
  to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante del área `legal` (carril A). Lo que el área `ledgers` no mira: que ningún rol de la
-- aplicación inserte en la tabla, que las tres funciones sean del servidor y solo suyas, que los dos
-- guardianes (quién publica y qué se publica) estén puestos, y que publicar sea del dueño de la tabla:
-- con otro dueño, el guardián rechazaría toda versión publicada.

create function private.schema_violations_legal()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  legal_functions (name, definer, server) as (
    values ('guard_legal_document', false, false), ('publish_legal_document', true, true),
           ('legal_documents_admin', true, true), ('legal_document_admin', true, true)),
  found as (
    select f.name, f.definer, f.server, p.oid, p.prosecdef, p.proconfig
    from legal_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private')
  select 'legal table writable by ' || r.rolname, 'public.legal_documents'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'public.legal_documents'::regclass, 'INSERT, UPDATE, DELETE, TRUNCATE')
     or pg_catalog.has_any_column_privilege(r.rolname::name, 'public.legal_documents'::regclass, 'INSERT, UPDATE')
  union all
  select 'legal function missing', 'private.' || f.name
  from legal_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'legal function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not (found.server and r.rolname = 'app_service')
  union all
  select 'legal function not executable by app_service', found.oid::regprocedure::text
  from found
  where found.server and not pg_catalog.has_function_privilege('app_service', found.oid, 'EXECUTE')
  union all
  select 'legal function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer)
     or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'legal function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'legal function not owned by the table owner', found.oid::regprocedure::text
  from found
  join pg_catalog.pg_proc p on p.oid = found.oid
  where found.name = 'publish_legal_document'
    and p.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.legal_documents'::regclass)
  union all
  select 'legal trigger missing or disabled: ' || t.tgname, 'public.legal_documents'
  from (values ('legal_documents_actor', 'guard_config_actor'), ('legal_documents_fill', 'guard_legal_document')) t (tgname, proname)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = 'public.legal_documents'::regclass and tg.tgname = t.tgname
      and tg.tgenabled in ('O', 'A') and n.nspname = 'private' and p.proname = t.proname)
$$;
revoke all on function private.schema_violations_legal() from public;
