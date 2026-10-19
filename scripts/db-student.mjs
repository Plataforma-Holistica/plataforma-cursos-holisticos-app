// Deja la base LOCAL lista para ver una lección como alumna con suscripción desde otro aparato
// de la misma red (el iPhone de quien revisa; T-203, decisión de Sergio del 2026-10-19): el
// curso de prueba «prueba-naturaleza» publicado y listado, y una alumna con su cuenta completa
// y una suscripción vigente. Imprime la dirección de «El bosque» con la IP de la red, el correo y
// una contraseña nueva.
//
//   pnpm db:student                      # alumna@prueba.test
//   pnpm db:student otra@prueba.test     # otro correo de prueba (sale en la marca de agua)
//
// Antes: `pnpm db:drafts` (lo hace `db:reset`), `pnpm media:upload-test` y `pnpm db:courses`.
// Después: `pnpm build && pnpm start`, que escucha en toda la red (`next dev` desde otra
// dirección recibe 403 en sus recursos de desarrollo).
//
// - Publicar es lo que hace `private.approve_course()`, pero como dueño de la base declarado
//   sistema: aprobar pide a alguien del equipo con su código, y el guardián de lo publicado
//   acepta al dueño declarado sistema. Repite sus revisiones y sus tres escrituras, con los
//   mismos candados. Correrlo dos veces no publica dos veces.
// - La alumna se da de alta con la API de administración del Auth local, se reclama
//   (`private.claim_account()`) y se completa como dueño declarando por quién actúa, como los
//   ayudantes de las pruebas. Solo con un correo `@prueba.test` (sin el `it-` que barren las
//   pruebas), y se niega con una cuenta del equipo, invitada o de un maestro. Cada corrida le
//   pone otra contraseña, y reclamar cierra sus sesiones.
// - Los consentimientos son un libro que no se borra: solo se agregan los que faltan.
// - La suscripción es `manual`, como la de las pruebas; si hay una viva ya vencida, se extiende.
//
// Solo corre contra la pila local, con las comprobaciones de `db:admins` y `db:courses`, y nunca
// imprime una llave ni la cadena de conexión: de un error, solo su código. Deja renglones en la
// auditoría y consentimientos: antes de cualquier prueba, apaga el servidor y `pnpm db:reset`.

import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_EMAIL = "alumna@prueba.test";
const SLUG = "prueba-naturaleza";
const VIDEO_FILE = "Nature + Forest.mp4";
const VIDEOS = join("supabase", "local", "test-videos.json");
const LEGAL = ["terms", "student_privacy_notice", "course_history_consent"];
const PORT = 3000;
// Sin letras ni números que se confundan al teclearla en un teléfono.
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function fail(message) {
  console.error(`db:student: ${message}`);
  process.exit(1);
}

/** Lo único que se dice de un error: su código. El mensaje puede traer datos de la conexión. */
function codeOf(error) {
  const code = error?.code ?? error?.status ?? error?.name;
  return typeof code === "string" || typeof code === "number" ? String(code) : "desconocido";
}

const email = (process.argv[2] ?? DEFAULT_EMAIL).trim().toLowerCase();
if (!/^[a-z0-9._-]+@prueba\.test$/.test(email) || email.startsWith("it-")) {
  fail("el correo tiene que ser de prueba: algo@prueba.test, sin empezar con «it-» (esos los borran las pruebas).");
}

// Lo que ya está en el entorno gana sobre el archivo.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("no corre en la integración continua ni en Vercel: este guion es solo para una base local.");
}
if (process.env.APP_ENV !== "local") fail("APP_ENV no es local.");

/** Una URL de la pila local, sin parámetros (`?host=` mandaría sobre lo demás). */
function localUrl(name) {
  const raw = process.env[name];
  if (!raw) fail(`falta ${name}. Mira .env.example.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} no es una URL.`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) fail(`${name} no apunta a la pila local. Este guion solo corre contra 127.0.0.1 o localhost.`);
  if ([...url.searchParams.keys()].length > 0) fail(`${name} no puede traer parámetros.`);
  return url;
}

const direct = localUrl("DATABASE_URL_DIRECT");
// Un túnel a una base remota también pasa por 127.0.0.1. La base local de Supabase tiene un
// usuario y una contraseña de fábrica que ninguna base remota tiene.
if (decodeURIComponent(direct.username) !== "postgres" || decodeURIComponent(direct.password) !== "postgres") {
  fail("DATABASE_URL_DIRECT debe entrar como postgres, con la contraseña de fábrica de la base local.");
}
// La que usará la aplicación que se levante después.
localUrl("DATABASE_URL");
const authUrl = localUrl("NEXT_PUBLIC_SUPABASE_URL");
const secret = process.env.SUPABASE_SECRET_KEY;
if (!secret) fail("falta SUPABASE_SECRET_KEY. Mira .env.example.");
if (!process.env.MUX_SIGNING_KEY_ID || !process.env.MUX_SIGNING_PRIVATE_KEY) {
  fail("faltan MUX_SIGNING_KEY_ID y MUX_SIGNING_PRIVATE_KEY en .env.local: sin ellas la aplicación no firma el video.");
}
const videos = existsSync(VIDEOS) ? JSON.parse(readFileSync(VIDEOS, "utf8")) : {};
const playbackId = videos[VIDEO_FILE]?.playback_id;
if (typeof playbackId !== "string") fail(`${VIDEO_FILE} no está en ${VIDEOS}: súbelo antes con pnpm media:upload-test.`);

/** Una contraseña nueva, de doce caracteres. */
function newPassword() {
  return Array.from({ length: 12 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");
}

/**
 * Las direcciones IPv4 privadas de esta máquina, primero las de Wi-Fi y Ethernet. Sin las de
 * WSL, Docker y las máquinas virtuales, que también son privadas pero el teléfono no alcanza.
 */
function lanAddresses() {
  const virtual = /vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V|Loopback|Bluetooth/i;
  const preferred = /Wi-?Fi|WLAN|Ethernet|en0|en1|wlan|eth/i;
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) continue;
      found.push({ name, address: entry.address });
    }
  }
  return found.sort((a, b) => Number(preferred.test(b.name)) - Number(preferred.test(a.name)));
}

// A `pg` se le pasan las partes ya revisadas, nunca la cadena.
const client = new pg.Client({
  host: direct.hostname.replace(/^\[|\]$/g, ""),
  port: direct.port === "" ? 5432 : Number(direct.port),
  user: "postgres",
  password: "postgres",
  database: decodeURIComponent(direct.pathname.replace(/^\//, "")),
});

/** Una transacción del dueño, declarando quién actúa. */
async function inTransaction(settings, work) {
  await client.query("begin");
  try {
    for (const [name, value] of settings) await client.query("select set_config($1, $2, true)", [name, value]);
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/** Publica y lista el curso, como `private.approve_course()`. Contesta qué hizo. */
async function publish(courseId) {
  return inTransaction([["app.actor_kind", "system"]], async () => {
    // Los mismos candados y en el mismo orden que aprobar: las dos listas y luego el curso.
    await client.query("select private.catalog_lock('practices'), private.catalog_lock('levels'), private.course_lock($1)", [courseId]);
    const registry = await client.query("select state::text as state from public.course_registry where course_id = $1 for no key update", [courseId]);
    const state = registry.rows[0]?.state;
    if (state === "published") return "ya estaba publicado";
    if (state !== "in_review") fail(`el curso está en «${state ?? "nada"}», no en revisión. Corre pnpm db:reset y pnpm db:courses.`);
    const checks = await client.query(
      `select
         exists (select 1 from public.practices p where p.id = c.practice_id and p.is_active) as practice,
         exists (select 1 from public.levels l where l.id = c.level_id and l.is_active) as level,
         not exists (
           select 1 from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
           where l.course_id = c.course_id and l.is_current and v.status <> 'ready') as videos
       from public.published_courses c where c.course_id = $1`,
      [courseId],
    );
    const facts = checks.rows[0];
    if (!facts?.practice || !facts.level) fail("la práctica o el nivel del curso no están activos.");
    if (!facts.videos) fail("algún video del curso no está listo.");
    await client.query(
      "update public.course_registry set state = 'published', first_published_at = coalesce(first_published_at, now()) where course_id = $1",
      [courseId],
    );
    await client.query("update public.published_courses set is_listed = true, published_at = now() where course_id = $1", [courseId]);
    await client.query(
      `update public.published_teachers set is_listed = true
        where teacher_id = (select teacher_id from public.course_registry where course_id = $1) and not is_listed`,
      [courseId],
    );
    return "publicado y listado";
  });
}

/** Se niega con una cuenta del equipo, invitada o de un maestro: cambiarle la contraseña y reclamarla la tocaría. */
async function refuseIfNotAStudent(id) {
  const found = await client.query(
    `select
       exists (select 1 from public.admin_capabilities where profile_id = $1) as team,
       exists (select 1 from private.admin_invitations where lower(email) = $2 or profile_id = $1) as invited,
       exists (select 1 from public.teachers where profile_id = $1) as teacher`,
    [id, email],
  );
  const facts = found.rows[0];
  if (facts?.team || facts?.invited) fail(`${email} es o fue del equipo, o tiene una invitación. Usa otro correo de prueba.`);
  if (facts?.teacher) fail(`${email} es de un maestro. Usa otro correo de prueba.`);
}

const password = newPassword();
let lessonId;
let published;
let subscription;
try {
  await client.connect();

  const legal = await client.query("select count(private.current_legal_document(d)) as current from unnest($1::public.legal_doc_type[]) as d", [LEGAL]);
  if (Number(legal.rows[0]?.current) !== LEGAL.length) fail("faltan los textos legales vigentes: corre pnpm db:drafts.");

  const course = await client.query(
    `select c.course_id, l.id::text as lesson_id, v.provider, v.status::text as status, v.provider_playback_id as playback_id
       from public.published_courses c
       join public.published_lessons l on l.course_id = c.course_id and l.is_current and l.position = 1
       join public.video_assets v on v.id = l.video_asset_id
      where c.slug = $1`,
    [SLUG],
  );
  const first = course.rows[0];
  if (!first) fail(`el curso ${SLUG} no está cargado: corre pnpm db:courses.`);
  if (first.provider !== "mux" || first.playback_id !== playbackId) {
    fail(`«El bosque» se cargó sin su video de Mux (antes de subirlo): corre pnpm db:reset y pnpm db:courses.`);
  }
  if (first.status !== "ready") fail("el video de «El bosque» no está listo.");
  lessonId = first.lesson_id;
  published = await publish(first.course_id);

  // La alumna, en el Auth local: nueva, o la misma con otra contraseña.
  const auth = createClient(authUrl.origin, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const existing = await client.query("select id::text as id from auth.users where lower(email) = $1", [email]);
  let id = existing.rows[0]?.id;
  if (id) {
    await refuseIfNotAStudent(id);
    const updated = await auth.auth.admin.updateUserById(id, { password, email_confirm: true });
    if (updated.error) fail(`el Auth local no cambió la contraseña (${codeOf(updated.error)}).`);
  } else {
    const invited = await client.query("select 1 from private.admin_invitations where lower(email) = $1", [email]);
    if ((invited.rowCount ?? 0) > 0) fail(`${email} tiene una invitación al equipo. Usa otro correo de prueba.`);
    const created = await auth.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) fail(`el Auth local no dio de alta a la alumna (${codeOf(created.error)}).`);
    id = created.data.user.id;
  }

  // Reclamar: apaga la marca de contraseña y fecha desde cuándo vale; cierra sus sesiones.
  const claimed = await inTransaction([["app.actor_id", id]], async () => {
    const result = await client.query("select private.claim_account() as status");
    return String(result.rows[0]?.status ?? "");
  });
  if (claimed !== "claimed" && claimed !== "already_claimed") fail(`no se pudo reclamar la cuenta (${claimed}).`);

  // Completar: nombre, edad y los consentimientos que falten sobre los textos vigentes. Falta el
  // que nunca se dio y el que se retiró: cuenta el último, como en la guarda.
  await inTransaction([["app.actor_id", id]], async () => {
    await client.query(
      `update public.profiles set display_name = coalesce(display_name, 'Alumna de prueba'), adult_declared_at = coalesce(adult_declared_at, now())
        where id = $1 and (display_name is null or adult_declared_at is null)`,
      [id],
    );
    await client.query(
      `insert into public.consents (profile_id, legal_document_id, origin)
       select $1, private.current_legal_document(d), 'signup' from unnest($2::public.legal_doc_type[]) as d
        where coalesce((
          select c.action <> 'granted' from public.consents c
           where c.profile_id = $1 and c.legal_document_id = private.current_legal_document(d)
           order by c.occurred_at desc, (c.action = 'withdrawn') desc
           limit 1), true)`,
      [id, LEGAL],
    );
  });

  // La suscripción: una viva con su periodo por delante.
  subscription = await inTransaction([], async () => {
    const live = await client.query(
      "select id, current_period_end > now() + interval '1 day' as ahead from public.subscriptions where profile_id = $1 and status in ('active', 'in_grace')",
      [id],
    );
    const row = live.rows[0];
    if (row?.ahead) return "ya tenía una vigente";
    if (row) {
      await client.query(
        `update public.subscriptions
            set status = 'active', last_renewal_failed_at = null,
                current_period_start = now() - interval '1 day', current_period_end = now() + interval '30 days'
          where id = $1`,
        [row.id],
      );
      return "extendida 30 días";
    }
    await client.query(
      `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
       values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '1 day', now() + interval '30 days')`,
      [id],
    );
    return "nueva, de 30 días";
  });
} catch (error) {
  fail(`la base local no contestó como se esperaba (${codeOf(error)}). ¿Está arriba? pnpm db:status.`);
} finally {
  await client.end().catch(() => {});
}

const path = `/cursos/${SLUG}/lecciones/${lessonId}`;
const addresses = lanAddresses();
console.log(`db:student: el curso ${SLUG}: ${published}. Suscripción: ${subscription}.`);
console.log("");
console.log(`  Correo:      ${email}`);
console.log(`  Contraseña:  ${password}   (nueva en cada corrida; si ya había entrado, entra de nuevo)`);
console.log("");
if (addresses.length === 0) {
  console.log(`  No encontré la dirección de esta máquina en la red. La lección: http://<IP>:${PORT}${path}`);
} else {
  console.log("  Desde el teléfono, en la misma red Wi-Fi:");
  for (const { name, address } of addresses) console.log(`    http://${address}:${PORT}${path}   (${name})`);
}
console.log("");
console.log("  1. Levanta la aplicación: pnpm build && pnpm start (escucha en toda la red).");
console.log("     Si Windows pregunta, deja pasar a Node en la red privada.");
console.log("  2. Entra con ese correo y esa contraseña. Es «El bosque», la lección 1: «El río» es de prueba, sin video.");
console.log("  3. Al terminar: apaga el servidor (el puerto 3000) y corre pnpm db:reset antes de cualquier prueba.");
