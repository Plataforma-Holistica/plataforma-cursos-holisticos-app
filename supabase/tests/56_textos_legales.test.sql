-- T-110 · Publicar una versión de un texto legal desde PA-89 (RF-713, RF-108, FL-57).
-- Esquema de backend §5.8. Decisiones de Sergio del 2026-10-28: nueve textos (los siete de PA-89
-- y los dos consentimientos), y una versión nueva del consentimiento del historial se vuelve a
-- pedir. Los borradores siguen siendo la versión 0 de local; los del abogado entran por aquí.
--
-- Desde esta solicitud, de la versión 1 en adelante solo publica private.publish_legal_document():
-- el servidor ya no inserta en la tabla. La función pasa la puerta de configuración con código
-- reciente, pone la versión (la última más uno), compara la versión que vio quien publica,
-- traduce el día de vigencia a la zona del periodo, y quién vuelve a aceptar lo decide el
-- guardián por el tipo de texto. Da lo mismo con borradores cargados y sin ellos: lo que
-- depende de ellos se lee de la tabla antes de probarlo.
begin;
\ir _ayuda.psql
select plan(80);

select pruebas.alta('c1100000-0000-0000-0000-000000000001', 'config-textos@prueba.test');
select pruebas.alta('b1100000-0000-0000-0000-000000000001', 'contenido-textos@prueba.test');
select pruebas.alta('a1100000-0000-0000-0000-000000000001', 'alumna-textos@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-textos@prueba.test';
select pruebas.dar_capacidad('c1100000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('b1100000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('c1100000-0000-0000-0000-000000000001');
select pruebas.equipar('b1100000-0000-0000-0000-000000000001');
select pruebas.reclamar('a1100000-0000-0000-0000-000000000001');

-- Lo que contestan las funciones cuando las llama una persona con su sesión de pruebas.
create function pruebas.publica(p_id uuid, p_type text, p_title text, p_body text, p_day date, p_seen integer)
returns jsonb
language sql as $$
  select pruebas.pide(p_id, format('private.publish_legal_document(%L, %L, %L, %L, %L)',
                                   p_type, p_title, p_body, p_day, p_seen))::jsonb
$$;
create function pruebas.textos(p_id uuid) returns jsonb
language sql as $$ select pruebas.pide(p_id, 'private.legal_documents_admin()')::jsonb $$;
create function pruebas.texto(p_id uuid, p_doc uuid) returns jsonb
language sql as $$ select pruebas.pide(p_id, format('private.legal_document_admin(%L)', p_doc))::jsonb $$;
-- El día de hoy en la zona del periodo, y la última versión de un tipo (nula si no hay).
create function pruebas.hoy() returns date
language sql stable as $$ select (now() at time zone 'America/Mexico_City')::date $$;
create function pruebas.ultima(p_type text) returns integer
language sql stable as $$ select max(version) from public.legal_documents where doc_type::text = p_type $$;
-- Una versión de un tipo en la lectura de configuración.
create function pruebas.en_lectura(p_read jsonb, p_type text, p_version integer) returns jsonb
language sql immutable as $$
  select v.value
  from jsonb_array_elements(p_read -> 'documents') d, jsonb_array_elements(d.value -> 'versions') v
  where d.value ->> 'doc_type' = p_type and (v.value ->> 'version')::integer = p_version
$$;

-- ---------------------------------------------------------------------------------------
-- Permisos: el servidor ya no inserta; las tres funciones son solo suyas.

select ok(
  has_table_privilege('app_service', 'public.legal_documents', 'select')
    and not has_table_privilege('app_service', 'public.legal_documents', 'insert'),
  'el servidor lee los textos legales y ya no los inserta');
select pruebas.como_servicio('c1100000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 1, 'Anexo', 'Texto', now())$$,
  '42501', null, 'ni con configuración y código reciente se inserta directo: va por la función');
select pruebas.como_dueno();
select ok(
  has_function_privilege('app_service', 'private.publish_legal_document(text, text, text, date, integer)', 'execute')
    and has_function_privilege('app_service', 'private.legal_documents_admin()', 'execute')
    and has_function_privilege('app_service', 'private.legal_document_admin(uuid)', 'execute'),
  'el servidor ejecuta las tres funciones de PA-89');
select ok(
  not has_function_privilege('authenticated', 'private.publish_legal_document(text, text, text, date, integer)', 'execute')
    and not has_function_privilege('anon', 'private.legal_documents_admin()', 'execute')
    and not has_function_privilege('authenticated', 'private.legal_document_admin(uuid)', 'execute'),
  'y nadie con sesión o sin ella las ejecuta');

-- ---------------------------------------------------------------------------------------
-- La puerta: configuración y un código reciente. Rechazar no escribe nada.

select count(*)::int as antes from public.legal_documents \gset
select is(pruebas.publica('a1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'forbidden', 'una cuenta común: forbidden');
select is(pruebas.publica('b1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'forbidden', 'alguien del equipo sin configuración: forbidden');
select pruebas.sin_codigo('c1100000-0000-0000-0000-000000000001');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'needs_fresh_code', 'con configuración y la sesión en primer nivel: que dé su código');
select is(pruebas.textos('c1100000-0000-0000-0000-000000000001'), null,
  'y con la sesión en primer nivel tampoco lee la tabla de PA-89');
select pruebas.equipar('c1100000-0000-0000-0000-000000000001');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour'
  where session_id = pruebas.sesion('c1100000-0000-0000-0000-000000000001');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'needs_fresh_code', 'con configuración y un código de hace una hora: que lo dé otra vez');
select is(pruebas.textos('c1100000-0000-0000-0000-000000000001') -> 'fresh_code', 'false'::jsonb,
  'con un código viejo sí lee, y la lectura dice que su código no es reciente');
select is(pruebas.textos('a1100000-0000-0000-0000-000000000001'), null, 'una cuenta común no lee la tabla de PA-89');
select is(pruebas.textos('b1100000-0000-0000-0000-000000000001'), null, 'ni alguien del equipo sin configuración');
select pruebas.equipar('c1100000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.legal_documents), :antes, 'ninguna respuesta de la puerta escribió');

-- ---------------------------------------------------------------------------------------
-- Lo que llega: el tipo, el título, el texto y el día. Rechazar no escribe nada.

select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'inventado', 'T', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un tipo que no existe: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', null, 'T', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'sin tipo: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', '   ', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un título en blanco: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', repeat('t', 201), 'Texto', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un título de más de 200 caracteres: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', E'Re\u0007embolsos', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un título con un carácter de control: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', E'Reem bolsos', 'Texto', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un título con un separador de renglón: invalid, diga lo que diga la configuración regional');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', E' \n\t ', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un texto en blanco: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', repeat('a', 200001), pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un texto de más de 200 000 caracteres: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', E'Uno\u0001dos', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un texto con un carácter de control: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', E'Uno\r\ndos', pruebas.hoy(), null) ->> 'answer',
  'invalid', 'un texto con retornos de carro: invalid (el servidor manda solo saltos de línea)');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', null, null) ->> 'answer',
  'invalid', 'sin día de vigencia: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', pruebas.hoy() + 367, null) ->> 'answer',
  'invalid', 'una vigencia a más de 366 días: invalid');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', pruebas.hoy() - 1, null) ->> 'answer',
  'past', 'una vigencia de ayer: past');
select is((select count(*)::int from public.legal_documents), :antes, 'ningún rechazo escribió');

-- ---------------------------------------------------------------------------------------
-- Publicar: la versión la pone la base; la vigencia de hoy rige al publicar.

select results_eq(
  $$select x ->> 'answer', (x ->> 'version')::integer, (x ->> 'effective_from')::timestamptz
    from pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', '  Reembolsos  ',
                         E'Primera versión.\n\nCon eñe.', pruebas.hoy(), null) x$$,
  $$values ('published', 1, now())$$,
  'el primer texto de un tipo es la versión 1, y con vigencia de hoy rige al publicar');
select results_eq(
  $$select title, body, requires_reconsent, published_by, effective_from from public.legal_documents
    where doc_type = 'refund_policy' and version = 1$$,
  $$values ('Reembolsos', E'Primera versión.\n\nCon eñe.', false, 'c1100000-0000-0000-0000-000000000001'::uuid, now())$$,
  'el título sin espacios a los lados, el texto tal cual, el autor es quien actúa');
select results_eq(
  $$select category::text, action, actor_id from public.audit_log order by id desc limit 1$$,
  $$values ('config', 'legal_documents.insert', 'c1100000-0000-0000-0000-000000000001'::uuid)$$,
  'publicar deja su renglón de auditoría');

-- Nadie publica sobre una versión que no vio.
select results_eq(
  $$select x ->> 'answer', (x ->> 'version')::integer
    from pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Otro', pruebas.hoy() + 1, null) x$$,
  $$values ('changed', 1)$$,
  'quien no vio la versión 1 recibe changed, con la versión que hay');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Otro', pruebas.hoy() + 1, 0) ->> 'answer',
  'changed', 'y quien vio una versión anterior, también');
select is((select count(*)::int from public.legal_documents where doc_type = 'refund_policy'), 1, 'changed no escribe');

-- Un día futuro rige a su medianoche en la zona del periodo.
select results_eq(
  $$select x ->> 'answer', (x ->> 'version')::integer, (x ->> 'effective_from')::timestamptz
    from pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Segunda versión.',
                         pruebas.hoy() + 10, 1) x$$,
  $$values ('published', 2, (pruebas.hoy() + 10)::timestamp at time zone 'America/Mexico_City')$$,
  'una vigencia futura empieza a la medianoche de ese día en Ciudad de México');
select is(private.current_legal_document('refund_policy'),
  (select id from public.legal_documents where doc_type = 'refund_policy' and version = 1),
  'y mientras tanto la vigente sigue siendo la versión 1');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Texto', pruebas.hoy() + 366, 2) ->> 'answer',
  'published', 'a 366 días todavía se publica');

-- ---------------------------------------------------------------------------------------
-- Quién vuelve a aceptar sale del tipo de texto, no de quien publica.

select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'teacher_privacy_notice', 'Aviso del maestro', 'Texto', pruebas.hoy() + 30,
                          pruebas.ultima('teacher_privacy_notice')) ->> 'answer',
  'published', 'se publica el aviso de privacidad del maestro');
select is((select requires_reconsent from public.legal_documents where doc_type = 'teacher_privacy_notice'
           order by version desc limit 1), true, 'el aviso del maestro se vuelve a pedir');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'community_policy', 'Comunidad', 'Texto', pruebas.hoy() + 30,
                          pruebas.ultima('community_policy')) ->> 'answer',
  'published', 'se publica la política de comunidad');
select is((select requires_reconsent from public.legal_documents where doc_type = 'community_policy'
           order by version desc limit 1), false, 'la de comunidad no se vuelve a pedir');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'recurring_charge_consent', 'Cobro recurrente', 'Texto', pruebas.hoy() + 30,
                          pruebas.ultima('recurring_charge_consent')) ->> 'answer',
  'published', 'se publica el consentimiento del cobro recurrente');
select is((select requires_reconsent from public.legal_documents where doc_type = 'recurring_charge_consent'
           order by version desc limit 1), false, 'el del cobro recurrente no se vuelve a pedir: se acepta en cada pago');

-- El consentimiento del historial puede tener borrador cargado: la versión es la última más
-- uno, nunca 0, y se vuelve a pedir (decisión de Sergio del 2026-10-28).
select coalesce(pruebas.ultima('course_history_consent'), 0) as historial \gset
select results_eq(
  $$select x ->> 'answer', (x ->> 'version')::integer
    from pruebas.publica('c1100000-0000-0000-0000-000000000001', 'course_history_consent', 'Historial', 'Texto',
                         pruebas.hoy() + 30, pruebas.ultima('course_history_consent')) x$$,
  format('values (%L, %s)', 'published', :historial + 1),
  'el consentimiento del historial sale con la versión siguiente a la que haya, borrador o no');
select is((select requires_reconsent from public.legal_documents where doc_type = 'course_history_consent'
           order by version desc limit 1), true, 'y se vuelve a pedir');

-- El guardián decide aunque quien inserte sea el dueño y mande otra cosa.
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from, requires_reconsent)
  values ('license_annex', 1, 'Anexo', 'Texto', now(), true);
insert into public.legal_documents (doc_type, version, title, body, effective_from, requires_reconsent)
  values ('teacher_agreement', 1, 'Contrato', 'Texto', now(), true);
select results_eq(
  $$select doc_type::text, requires_reconsent from public.legal_documents
    where doc_type in ('license_annex', 'teacher_agreement') order by doc_type::text$$,
  $$values ('license_annex', false), ('teacher_agreement', false)$$,
  'el contrato y el anexo no se vuelven a pedir, aunque quien inserte diga que sí');
select pruebas.como_dueno();

-- Desde la versión 1, el guardián solo deja insertar al dueño de la tabla: aunque el servidor
-- recuperara el permiso, no publicaría por fuera de la función.
grant insert on public.legal_documents to app_service;
select pruebas.como_servicio('c1100000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 2, 'Anexo', 'Texto', now())$$,
  '42501', 'public.legal_documents: from version 1 on, a document is published only through private.publish_legal_document',
  'el guardián detiene al servidor aunque tenga el permiso');
select pruebas.como_dueno();
revoke insert on public.legal_documents from app_service;

-- ---------------------------------------------------------------------------------------
-- Las programadas: una más nueva con fecha anterior o igual reemplaza a otra antes de que rija.
-- refund_policy tiene la 1 vigente, la 2 a diez días y la 3 a 366.

select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Corrige la segunda.',
                          pruebas.hoy() + 5, 3) ->> 'answer',
  'published', 'la versión 4, a cinco días, se publica');
select pruebas.textos('c1100000-0000-0000-0000-000000000001') as lectura \gset
select results_eq(
  format($$select v ->> 'state' from (values (pruebas.en_lectura(%L::jsonb, 'refund_policy', 1)),
                                            (pruebas.en_lectura(%L::jsonb, 'refund_policy', 2)),
                                            (pruebas.en_lectura(%L::jsonb, 'refund_policy', 3)),
                                            (pruebas.en_lectura(%L::jsonb, 'refund_policy', 4))) t (v)$$,
         :'lectura', :'lectura', :'lectura', :'lectura'),
  $$values ('current'), ('superseded'), ('superseded'), ('scheduled')$$,
  'la 1 rige, la 4 está programada, y la 2 y la 3 ya no regirán nunca');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'refund_policy', 'Reembolsos', 'Después.',
                          pruebas.hoy() + 20, 4) ->> 'answer',
  'published', 'la versión 5, a veinte días, se publica');
select pruebas.textos('c1100000-0000-0000-0000-000000000001') as lectura \gset
select results_eq(
  format($$select v ->> 'state' from (values (pruebas.en_lectura(%L::jsonb, 'refund_policy', 4)),
                                            (pruebas.en_lectura(%L::jsonb, 'refund_policy', 5))) t (v)$$,
         :'lectura', :'lectura'),
  $$values ('scheduled'), ('scheduled')$$,
  'una más nueva con fecha posterior no reemplaza: las dos están programadas');

-- Con la misma fecha también reemplaza: rige la de número más alto desde el mismo instante.
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'community_policy', 'Comunidad', 'Corrige el mismo día.',
                          pruebas.hoy() + 30, pruebas.ultima('community_policy')) ->> 'answer',
  'published', 'otra política de comunidad, para el mismo día que la anterior');
select pruebas.textos('c1100000-0000-0000-0000-000000000001') as lectura \gset
select results_eq(
  format($$select v ->> 'state' from (values (pruebas.en_lectura(%L::jsonb, 'community_policy', pruebas.ultima('community_policy') - 1)),
                                            (pruebas.en_lectura(%L::jsonb, 'community_policy', pruebas.ultima('community_policy')))) t (v)$$,
         :'lectura', :'lectura'),
  $$values ('superseded'), ('scheduled')$$,
  'la de antes, con la misma fecha, ya no regirá nunca');

-- ---------------------------------------------------------------------------------------
-- La lectura de PA-89: los nueve tipos, sin el texto; el texto, por su identificador.

select results_eq(
  format($$select d ->> 'doc_type' from jsonb_array_elements(%L::jsonb -> 'documents') d$$, :'lectura'),
  $$values ('terms'), ('student_privacy_notice'), ('teacher_privacy_notice'), ('community_policy'), ('refund_policy'),
           ('teacher_agreement'), ('license_annex'), ('course_history_consent'), ('recurring_charge_consent')$$,
  'los nueve tipos, en el orden del tipo enumerado');
select is(:'lectura'::jsonb -> 'fresh_code', 'true'::jsonb, 'con código reciente, la lectura lo dice');
select is((:'lectura'::jsonb ->> 'today')::date, pruebas.hoy(), 'y trae el día de hoy en la zona del periodo');
select results_eq(
  format($$select (d ->> 'last_version')::integer, jsonb_array_length(d -> 'versions')
           from jsonb_array_elements(%L::jsonb -> 'documents') d where d ->> 'doc_type' = 'refund_policy'$$, :'lectura'),
  $$values (5, 5)$$,
  'por tipo: la última versión y todas las versiones');
select results_eq(
  format($$select (v ->> 'version')::integer from jsonb_array_elements(
             (select d -> 'versions' from jsonb_array_elements(%L::jsonb -> 'documents') d
              where d ->> 'doc_type' = 'refund_policy')) v$$, :'lectura'),
  $$values (5), (4), (3), (2), (1)$$,
  'de la más nueva a la más vieja');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.en_lectura(:'lectura'::jsonb, 'refund_policy', 1)) k),
  array['body_sha256', 'effective_from', 'id', 'is_draft', 'published_at', 'state', 'title', 'version'],
  'cada versión trae su forma, sin el texto');
select is(pruebas.en_lectura(:'lectura'::jsonb, 'refund_policy', 1) ->> 'body_sha256',
  (select encode(body_sha256, 'hex') from public.legal_documents where doc_type = 'refund_policy' and version = 1),
  'con la huella del texto en hexadecimal');
select results_eq(
  format($$select d -> 'versions' from jsonb_array_elements(%L::jsonb -> 'documents') d where d ->> 'doc_type' = 'refund_policy'$$,
         :'lectura'),
  format($$values (%L::jsonb)$$, (select pruebas.textos('c1100000-0000-0000-0000-000000000001') #> '{documents,4,versions}')),
  'leer dos veces da lo mismo');

select id as reembolsos1 from public.legal_documents where doc_type = 'refund_policy' and version = 1 \gset
select results_eq(
  format($$select x #>> '{document,body}', x #>> '{document,doc_type}', (x #>> '{document,version}')::integer
           from pruebas.texto('c1100000-0000-0000-0000-000000000001', %L) x$$, :'reembolsos1'),
  $$values (E'Primera versión.\n\nCon eñe.', 'refund_policy', 1)$$,
  'configuración lee el texto de una versión por su identificador');
select is(pruebas.texto('c1100000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000000') -> 'document', 'null'::jsonb,
  'un identificador que no existe: sin documento');
select is(pruebas.texto('a1100000-0000-0000-0000-000000000001', :'reembolsos1'), null, 'una cuenta común no lo lee');
select pruebas.sin_codigo('c1100000-0000-0000-0000-000000000001');
select is(pruebas.texto('c1100000-0000-0000-0000-000000000001', :'reembolsos1'), null,
  'ni configuración con la sesión en primer nivel');
select pruebas.equipar('c1100000-0000-0000-0000-000000000001');

-- Un borrador vigente se marca como borrador.
select pruebas.como_dueno_sistema();
select set_config('app.legal_drafts', 'on', true);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  select 'terms', 0, 'Borrador', 'Borrador', timestamptz '2026-10-01 06:00:00+00'
  where not exists (select 1 from public.legal_documents where doc_type = 'terms');
select pruebas.como_dueno();
select pruebas.textos('c1100000-0000-0000-0000-000000000001') as lectura \gset
select is(pruebas.en_lectura(:'lectura'::jsonb, 'terms', 0) ->> 'is_draft', 'true', 'un borrador se marca como borrador');

-- Los términos y el aviso del alumno, publicados por la función, se vuelven a pedir. Van después del
-- borrador: publicarlos antes le quitaría a esa prueba su versión 0 en una base sin borradores.
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'terms', 'Términos', 'Texto', pruebas.hoy() + 30,
                          pruebas.ultima('terms')) ->> 'answer',
  'published', 'se publican unos términos');
select is((select requires_reconsent from public.legal_documents where doc_type = 'terms'
           order by version desc limit 1), true, 'los términos se vuelven a pedir');
select is(pruebas.publica('c1100000-0000-0000-0000-000000000001', 'student_privacy_notice', 'Aviso del alumno', 'Texto', pruebas.hoy() + 30,
                          pruebas.ultima('student_privacy_notice')) ->> 'answer',
  'published', 'se publica el aviso de privacidad del alumno');
select is((select requires_reconsent from public.legal_documents where doc_type = 'student_privacy_notice'
           order by version desc limit 1), true, 'el aviso del alumno se vuelve a pedir');

-- ---------------------------------------------------------------------------------------
-- El vigilante del área: provoca cada regla y vuelve a quedar en orden.

select is_empty($$select * from private.schema_violations_legal()$$, 'el área legal está en orden');
select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_legal' and unusable_reason is null),
  'y el agregador la descubre');
grant insert on public.legal_documents to app_service;
select results_eq($$select problem, object_name from private.schema_violations_legal()$$,
  $$values ('legal table writable by app_service', 'public.legal_documents')$$,
  'avisa si el servidor recupera el insert');
revoke insert on public.legal_documents from app_service;
grant execute on function private.publish_legal_document(text, text, text, date, integer) to authenticated;
select results_eq($$select problem, object_name like 'private.publish_legal_document(%' from private.schema_violations_legal()$$,
  $$values ('legal function executable by authenticated', true)$$,
  'avisa si una sesión puede ejecutar una función del servidor');
revoke execute on function private.publish_legal_document(text, text, text, date, integer) from authenticated;
revoke execute on function private.legal_documents_admin() from app_service;
select results_eq($$select problem, object_name like 'private.legal_documents_admin(%' from private.schema_violations_legal()$$,
  $$values ('legal function not executable by app_service', true)$$,
  'avisa si el servidor pierde una función suya');
grant execute on function private.legal_documents_admin() to app_service;
alter table public.legal_documents disable trigger legal_documents_fill;
select results_eq($$select problem, object_name from private.schema_violations_legal()$$,
  $$values ('legal trigger missing or disabled: legal_documents_fill', 'public.legal_documents')$$,
  'avisa si el guardián se apaga');
alter table public.legal_documents enable trigger legal_documents_fill;
alter table public.legal_documents disable trigger legal_documents_actor;
select results_eq($$select problem, object_name from private.schema_violations_legal()$$,
  $$values ('legal trigger missing or disabled: legal_documents_actor', 'public.legal_documents')$$,
  'avisa si se apaga el guardián de quién publica');
alter table public.legal_documents enable trigger legal_documents_actor;
-- Con el mismo nombre y la misma función, pero después de insertar o para otra operación, ya no detiene nada.
drop trigger legal_documents_fill on public.legal_documents;
create trigger legal_documents_fill after insert on public.legal_documents
  for each row execute function private.guard_legal_document();
select results_eq($$select problem, object_name from private.schema_violations_legal()$$,
  $$values ('legal trigger missing or disabled: legal_documents_fill', 'public.legal_documents')$$,
  'avisa si el guardián corre después de insertar');
drop trigger legal_documents_fill on public.legal_documents;
create trigger legal_documents_fill before insert on public.legal_documents
  for each row execute function private.guard_legal_document();
drop trigger legal_documents_actor on public.legal_documents;
create trigger legal_documents_actor before update on public.legal_documents
  for each statement execute function private.guard_config_actor();
select results_eq($$select problem, object_name from private.schema_violations_legal()$$,
  $$values ('legal trigger missing or disabled: legal_documents_actor', 'public.legal_documents')$$,
  'avisa si el guardián de quién publica no corre al insertar cada fila');
drop trigger legal_documents_actor on public.legal_documents;
create trigger legal_documents_actor before insert on public.legal_documents
  for each row execute function private.guard_config_actor();
select is_empty($$select * from private.schema_violations_legal()$$, 'y todo en su lugar otra vez');

-- Si publicar no es del dueño de la tabla, el guardián rechazaría toda versión publicada.
-- Va al último: devolverle la función a su dueño pediría ser el nuevo. Lo deshace el rollback del final,
-- como el permiso de crear en el esquema que necesita el dueño nuevo.
grant app_service to postgres;
grant create on schema private to app_service;
alter function private.publish_legal_document(text, text, text, date, integer) owner to app_service;
select results_eq($$select problem, object_name like 'private.publish_legal_document(%' from private.schema_violations_legal()$$,
  $$values ('legal function not owned by the table owner', true)$$,
  'avisa si la función de publicar cambia de dueño');

select pruebas.limpiar();
select * from finish();
rollback;
