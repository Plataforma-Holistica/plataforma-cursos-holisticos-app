-- T-104 · Textos legales con versión y consentimientos (RF-108, RF-713).
-- Esquema de backend §5.8, §6.5 y §7. Usa tipos de documento que los borradores locales
-- no cargan, para dar lo mismo con ellos y sin ellos.
begin;
\ir _ayuda.psql
select plan(63);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'alumna-legal@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'otra-legal@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config-legal@prueba.test');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');

-- ---------------------------------------------------------------------------------------
-- Permisos: el público lee el texto y no quién lo publicó; la persona no lee su IP.

select ok(
  has_column_privilege('anon', 'public.legal_documents', 'body', 'select'),
  'el visitante puede leer el texto de un documento legal');
select ok(
  not has_column_privilege('anon', 'public.legal_documents', 'published_by', 'select')
    and not has_column_privilege('authenticated', 'public.legal_documents', 'published_by', 'select'),
  'nadie con sesión o sin ella lee quién publicó un texto');
select ok(
  has_column_privilege('authenticated', 'public.consents', 'occurred_at', 'select')
    and not has_column_privilege('authenticated', 'public.consents', 'ip', 'select')
    and not has_column_privilege('authenticated', 'public.consents', 'user_agent', 'select'),
  'la persona lee sus consentimientos, sin la IP ni el navegador');
select ok(
  not has_table_privilege('anon', 'public.consents', 'select'),
  'el visitante no lee consentimientos');
select ok(
  has_table_privilege('app_service', 'public.legal_documents', 'select')
    and has_table_privilege('app_service', 'public.legal_documents', 'insert')
    and not has_any_column_privilege('app_service', 'public.legal_documents', 'update')
    and not has_table_privilege('app_service', 'public.legal_documents', 'delete')
    and not has_table_privilege('app_service', 'public.legal_documents', 'truncate'),
  'app_service lee e inserta textos legales, y nada más');
select ok(
  has_table_privilege('app_service', 'public.consents', 'select')
    and has_table_privilege('app_service', 'public.consents', 'insert')
    and not has_any_column_privilege('app_service', 'public.consents', 'update')
    and not has_table_privilege('app_service', 'public.consents', 'delete')
    and not has_table_privilege('app_service', 'public.consents', 'truncate'),
  'app_service lee e inserta consentimientos, y nada más');

-- ---------------------------------------------------------------------------------------
-- Publicar: la huella, el autor y la fecha los escribe la base, no quien inserta.

select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select lives_ok(
  $$insert into public.legal_documents
      (doc_type, version, title, body, body_sha256, effective_from, published_by, published_at)
    values ('refund_policy', 1, 'Reembolsos', 'Texto con eñe: año', decode(repeat('00', 32), 'hex'),
            now(), 'a0000000-0000-0000-0000-000000000001', timestamptz '2020-01-01')$$,
  'configuración con segundo factor publica una versión');

select pruebas.como_dueno();
select is(
  (select encode(body_sha256, 'hex') from public.legal_documents
   where doc_type = 'refund_policy' and version = 1),
  '421bb1ed44d23c18e95f76ded051a4d1177937191fcf24689c38301a2b774160',
  'la huella es el SHA-256 del texto en UTF-8, no la que mandó quien insertó');
select is(
  (select published_by from public.legal_documents where doc_type = 'refund_policy' and version = 1),
  'c0000000-0000-0000-0000-000000000001'::uuid,
  'el autor es quien actúa, no el que mandó quien insertó');
select is(
  (select published_at from public.legal_documents where doc_type = 'refund_policy' and version = 1),
  now(), 'la fecha de publicación es la de la base');
select results_eq(
  $$select category::text, action, actor_id, new_value ? 'body', new_value ? 'body_sha256'
    from public.audit_log order by id desc limit 1$$,
  $$values ('config', 'legal_documents.insert', 'c0000000-0000-0000-0000-000000000001'::uuid, false, true)$$,
  'publicar deja un renglón de auditoría con la huella y sin el texto');

-- Quién no publica.
select pruebas.como_servicio();
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 1, 'T', 'B', now())$$,
  '42501', null, 'sin autor declarado no se publica');
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 1, 'T', 'B', now())$$,
  '42501', null, 'una alumna no publica, ni por el camino de servicio');
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001', 'aal1');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 1, 'T', 'B', now())$$,
  '42501', null, 'configuración sin segundo factor no publica');
select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 1, 'T', 'B', now())$$,
  '42501', null, 'con su sesión, ni configuración inserta: va por el servidor');
select pruebas.como_visitante();
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 1, 'T', 'B', now())$$,
  '42501', null, 'el visitante no publica');

-- El sistema puede cargar la primera versión, y queda sin autor.
select pruebas.como_sistema();
select lives_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('community_policy', 1, 'Comunidad', 'Texto de arranque', now())$$,
  'el sistema carga la versión 1 de un texto');
select pruebas.como_dueno();
select is(
  (select published_by from public.legal_documents where doc_type = 'community_policy' and version = 1),
  null, 'y queda sin autor: es un texto de arranque');

-- ---------------------------------------------------------------------------------------
-- Las versiones crecen y ninguna rige hacia atrás.

select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('refund_policy', 1, 'T', 'B', now() + interval '1 day')$$,
  '23514', null, 'una versión que ya existe no se vuelve a publicar');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('refund_policy', 2, 'T', 'B', now())$$,
  '23514', null, 'una versión nueva no rige desde la misma fecha que la anterior');
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('license_annex', 1, 'T', 'B', now() - interval '1 day')$$,
  '23514', null, 'una versión publicada no rige hacia atrás');
select lives_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('refund_policy', 2, 'Reembolsos', 'Texto nuevo', now() + interval '1 day')$$,
  'la versión siguiente, con vigencia posterior, sí se publica');
select pruebas.como_sistema();
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('refund_policy', 3, 'T', 'B', now() + interval '2 days')$$,
  '42501', null, 'desde la versión 2, un texto lo publica una persona, no el sistema');

-- ---------------------------------------------------------------------------------------
-- La versión 0 es un borrador: solo la carga el dueño de la tabla, como sistema y con el
-- ajuste del guion de borradores. Cada caso quita una sola de las tres condiciones.

select pruebas.como_dueno();
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('recurring_charge_consent', 0, 'Borrador', 'B', timestamptz '2020-01-01')$$,
  '42501', null, 'el dueño, sin declararse y sin el ajuste, no carga un borrador');
select set_config('app.actor_kind', 'system', true);
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('recurring_charge_consent', 0, 'Borrador', 'B', timestamptz '2020-01-01')$$,
  '42501', null, 'el dueño como sistema, sin el ajuste, no carga un borrador');
select set_config('app.legal_drafts', 'ON', true);
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('recurring_charge_consent', 0, 'Borrador', 'B', timestamptz '2020-01-01')$$,
  '42501', null, 'el ajuste tiene que valer exactamente on');
select pruebas.como_sistema();
select set_config('app.legal_drafts', 'on', true);
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('recurring_charge_consent', 0, 'Borrador', 'B', timestamptz '2020-01-01')$$,
  '42501', null, 'el servidor no carga un borrador aunque se declare sistema y ponga el ajuste');
select pruebas.como_dueno();
select set_config('app.actor_id', 'c0000000-0000-0000-0000-000000000001', true);
select set_config('app.actor_aal', 'aal2', true);
select set_config('app.legal_drafts', 'on', true);
select throws_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('recurring_charge_consent', 0, 'Borrador', 'B', timestamptz '2020-01-01')$$,
  '42501', null, 'el dueño a nombre de una persona, con el ajuste, tampoco');
select pruebas.como_dueno();
select set_config('app.actor_kind', 'system', true);
select set_config('app.legal_drafts', 'on', true);
select lives_ok(
  $$insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('recurring_charge_consent', 0, 'Borrador', 'B', timestamptz '2020-01-01')$$,
  'el dueño, como sistema y con el ajuste, sí carga un borrador');
-- Un borrador de un tipo que ya tiene versión 1: queda superado.
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('community_policy', 0, 'Borrador', 'B', timestamptz '2020-01-01');

-- ---------------------------------------------------------------------------------------
-- Es un libro: ni el dueño de la tabla lo edita, lo borra o lo vacía.

select throws_ok(
  $$update public.legal_documents set title = 'Otro'$$,
  '42501', 'append-only ledger public.legal_documents: UPDATE is not allowed',
  'el dueño de la tabla no puede editar un texto publicado');
select throws_ok(
  $$delete from public.legal_documents$$,
  '42501', 'append-only ledger public.legal_documents: DELETE is not allowed',
  'ni borrarlo');
select throws_ok(
  $$truncate public.legal_documents cascade$$,
  '42501', null, 'ni vaciar la tabla');

-- ---------------------------------------------------------------------------------------
-- Lectura: lo vigente y público para todos; lo de maestros y lo futuro, no.

select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('teacher_agreement', 1, 'Contrato', 'Texto de maestros', now());

select pruebas.como_dueno();
select ok(
  (select count(*) filter (where doc_type = 'teacher_agreement') = 1
      and count(*) filter (where effective_from > now()) >= 1
   from public.legal_documents),
  'hay un texto de maestros y uno con vigencia futura que no deben verse');
select count(*)::int as documentos from public.legal_documents \gset

select pruebas.como_visitante();
select is(
  (select count(*)::int from public.legal_documents where doc_type = 'refund_policy' and version = 1),
  1, 'el visitante lee un texto público vigente');
select is(
  (select count(*)::int from public.legal_documents where doc_type = 'teacher_agreement'),
  0, 'el visitante no lee los textos de maestros');
select is(
  (select count(*)::int from public.legal_documents where effective_from > now()),
  0, 'el visitante no lee un texto que todavía no rige');
select throws_ok(
  'select published_by from public.legal_documents',
  '42501', null, 'el visitante no puede pedir la columna del autor');

select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.legal_documents where doc_type = 'teacher_agreement'),
  0, 'una alumna tampoco lee los textos de maestros');

select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select is(
  (select count(*)::int from public.legal_documents), :documentos,
  'configuración lee todos los textos, también los futuros');

-- ---------------------------------------------------------------------------------------
-- Una sola definición de «vigente».

select pruebas.como_dueno();
select id as refund1 from public.legal_documents where doc_type = 'refund_policy' and version = 1 \gset
select id as refund2 from public.legal_documents where doc_type = 'refund_policy' and version = 2 \gset
select id as cargo0 from public.legal_documents where doc_type = 'recurring_charge_consent' and version = 0 \gset
select id as comunidad0 from public.legal_documents where doc_type = 'community_policy' and version = 0 \gset

select pruebas.como_servicio();
select is(
  private.current_legal_document('refund_policy'), :'refund1'::uuid,
  'el vigente es el de mayor vigencia ya iniciada, no el futuro');
select is(
  private.current_legal_document('recurring_charge_consent'), :'cargo0'::uuid,
  'un borrador es el vigente mientras no haya versión publicada');
select is(
  private.current_legal_document('license_annex'), null,
  'un tipo sin ningún texto no tiene vigente');
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$select private.current_legal_document('refund_policy')$$,
  '42501', null, 'una persona con sesión no ejecuta esa función: la usa el servidor');

-- ---------------------------------------------------------------------------------------
-- Consentimientos: solo la propia persona, sobre el texto vigente, con la hora de la base.

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select lives_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin, ip, user_agent, occurred_at)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'signup', '203.0.113.7', 'Navegador',
                   timestamptz '2020-01-01')$$, :'refund1'),
  'el servidor guarda el consentimiento de la persona por la que actúa');
select pruebas.como_dueno();
select is(
  (select occurred_at from public.consents where legal_document_id = :'refund1'::uuid),
  now(), 'la hora del consentimiento es la de la base, no la que mandó quien insertó');

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000002', %L, 'signup')$$, :'refund1'),
  '42501', null, 'nadie consiente a nombre de otra persona');
select pruebas.como_servicio();
select throws_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'signup')$$, :'refund1'),
  '42501', null, 'sin autor declarado no hay consentimiento');
select pruebas.como_sistema();
select throws_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'signup')$$, :'refund1'),
  '42501', null, 'el sistema no consiente por nadie');

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'signup')$$, :'refund2'),
  '23514', null, 'no se consiente un texto que todavía no rige');
select throws_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'signup')$$, :'comunidad0'),
  '23514', null, 'ni un borrador que ya fue superado por una versión publicada');
select lives_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'checkout')$$, :'cargo0'),
  'un borrador vigente sí se puede consentir: es lo que hay en local');
select lives_ok(
  format($$insert into public.consents (profile_id, legal_document_id, action, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'withdrawn', 'account_settings')$$, :'refund1'),
  'retirar un consentimiento es una fila nueva');
select throws_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'inventado')$$, :'refund1'),
  '23514', null, 'el origen sale de una lista cerrada');
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  format($$insert into public.consents (profile_id, legal_document_id, origin)
           values ('a0000000-0000-0000-0000-000000000001', %L, 'signup')$$, :'refund1'),
  '42501', null, 'con su sesión la persona no inserta consentimientos: va por el servidor');

-- Lectura: cada quien los suyos. Se siembra uno ajeno para que la prueba pueda fallar.
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000002');
insert into public.consents (profile_id, legal_document_id, origin)
  values ('a0000000-0000-0000-0000-000000000002', :'refund1', 'signup');
select pruebas.como_dueno();
select count(*)::int as propios from public.consents
  where profile_id = 'a0000000-0000-0000-0000-000000000001' \gset
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from (select id from public.consents) c), :propios,
  'la alumna ve todos sus consentimientos');
select is(
  (select count(*)::int from (select id from public.consents
                              where profile_id = 'a0000000-0000-0000-0000-000000000002') c),
  0, 'y ninguno de otra persona, aunque exista');
select throws_ok(
  'select ip from public.consents',
  '42501', null, 'la alumna no puede pedir la columna de la IP');

-- Solo se pueden vaciar la IP y el navegador: es la puerta de la eliminación de cuentas.
select pruebas.como_dueno();
select throws_ok(
  $$update public.consents set origin = 'checkout'$$,
  '42501', null, 'ni el dueño de la tabla cambia otra columna de un consentimiento');
select throws_ok(
  $$update public.consents set ip = '198.51.100.1'$$,
  '42501', null, 'ni le pone otra IP');
select lives_ok(
  $$update public.consents set ip = null, user_agent = null$$,
  'vaciar la IP y el navegador sí se puede');
select throws_ok(
  $$delete from public.consents$$,
  '42501', 'append-only ledger public.consents: DELETE is not allowed',
  'un consentimiento no se borra');
select throws_ok(
  $$truncate public.consents$$,
  '42501', 'append-only ledger public.consents: TRUNCATE is not allowed',
  'ni se vacía la tabla');

-- ---------------------------------------------------------------------------------------
-- El vigilante ve los permisos por columna: se le da uno de más y tiene que avisar.

grant update (ip) on public.consents to app_service;
select isnt_empty(
  $$select * from private.schema_violations() where object_name = 'public.consents'$$,
  'schema_violations() avisa si el servidor recibe permiso de editar una columna de un libro');
revoke update (ip) on public.consents from app_service;

select pruebas.limpiar();
select * from finish();
rollback;
