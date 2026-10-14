// Invita en la base LOCAL a las primeras personas del equipo de administración, con todas
// las capacidades (RF-712; esquema de backend §6.2). Es el arranque: nadie del equipo puede
// invitar todavía, así que lo hace el dueño de la base, declarado sistema, con
// `private.system_invite_admin()`.
//
//   pnpm db:admins ana@ejemplo.test beto@ejemplo.test
//
// Hacen falta dos personas con configuración para que el equipo se pueda administrar a sí
// mismo: con menos, a nadie se le puede quitar esa capacidad.
//
// Solo corre contra la base local. En producción no hay guion: el arranque lo hace a mano
// quien opera la base, con el procedimiento del manual de operación.
//
// Invitar no le toca nada a una cuenta que ya existe, y no manda ningún correo. Cada
// persona acepta como cualquier invitada: prueba su buzón (termina su registro, o recupera
// su contraseña) en el navegador con el que va a entrar, y configura su segundo factor.
//
// Cada invitación deja renglones en la auditoría, que no admite borrado, y las pruebas de
// base cuentan esos renglones: después de correr este guion, `pnpm db:reset` antes de
// `pnpm test:db`.

import { existsSync } from "node:fs";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Todas: es el arranque. Después, cada quien reparte desde la pantalla del equipo.
const CAPABILITIES = ["content", "finance", "moderation", "support", "config"];
const INVITED = new Set(["invited_new", "invited_existing"]);
const NEXT = {
  invited_new: "no tiene cuenta: que la cree con ese correo en /registro.",
  invited_existing: "ya tiene cuenta: que recupere su contraseña en /recuperar, en el navegador con el que va a entrar.",
  already_invited: "ya tenía una invitación vigente. No se cambió nada.",
  already_member: "ya es del equipo. No se le invita: se le dan capacidades desde la pantalla del equipo.",
  ineligible: "su cuenta no está activa. No se le puede invitar.",
  invalid: "eso no es un correo.",
  unavailable: "falta el parámetro VIGENCIA_INVITACION_DIAS, o no vale. No se puede invitar a nadie.",
};

function fail(message) {
  console.error(`db:admins: ${message}`);
  process.exit(1);
}

const emails = process.argv.slice(2);
if (emails.length === 0) fail("faltan los correos. Uso: pnpm db:admins <correo> [<correo> ...]");
for (const email of emails) {
  // La forma de verdad la revisa la base. Esto solo detiene lo que no es un correo ni de lejos.
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`«${email}» no es un correo.`);
}
if (new Set(emails.map((email) => email.trim().toLowerCase())).size !== emails.length) fail("hay un correo repetido.");

// Lo que ya está en el entorno gana sobre el archivo: así la integración continua pasa
// sus propios valores.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

if (process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("no corre en Vercel: este guion es solo para una base local.");
}

const raw = process.env.DATABASE_URL_DIRECT;
if (!raw) fail("falta DATABASE_URL_DIRECT. Mira .env.example.");
let url;
try {
  url = new URL(raw);
} catch {
  fail("DATABASE_URL_DIRECT no es una URL.");
}
if (!LOCAL_HOSTS.has(url.hostname)) {
  fail("DATABASE_URL_DIRECT no apunta a la base local. Este guion solo corre contra 127.0.0.1 o localhost.");
}
// `pg` deja que los parámetros de la cadena manden sobre lo demás: con `?host=` este
// guion pasaría por local y escribiría en una base remota.
if ([...url.searchParams.keys()].length > 0) {
  fail("DATABASE_URL_DIRECT no puede traer parámetros.");
}
// Un túnel a una base remota también pasa por 127.0.0.1. La base local de Supabase tiene
// un usuario y una contraseña de fábrica que ninguna base remota tiene.
if (decodeURIComponent(url.username) !== "postgres" || decodeURIComponent(url.password) !== "postgres") {
  fail("DATABASE_URL_DIRECT debe entrar como postgres, con la contraseña de fábrica de la base local.");
}

// A `pg` se le pasan las partes ya revisadas, nunca la cadena.
const client = new pg.Client({
  host: url.hostname.replace(/^\[|\]$/g, ""),
  port: url.port === "" ? 5432 : Number(url.port),
  user: "postgres",
  password: "postgres",
  database: decodeURIComponent(url.pathname.replace(/^\//, "")),
});

const answers = [];
try {
  await client.connect();
  for (const email of emails) {
    // Una transacción por persona: lo que una contesta no deshace a las anteriores.
    await client.query("begin");
    try {
      // Lo hace el sistema, no una persona: queda así en la auditoría.
      await client.query("select set_config('app.actor_kind', 'system', true)");
      const result = await client.query("select private.system_invite_admin($1::text, $2::text[]::public.capability[]) as answer", [
        email,
        CAPABILITIES,
      ]);
      await client.query("commit");
      answers.push({ email, answer: String(result.rows[0]?.answer ?? "") });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  }
} catch (error) {
  fail(`no se pudo invitar (${error.code ?? "sin código"}): ${error.message}`);
} finally {
  await client.end().catch(() => {});
}

for (const { email, answer } of answers) {
  console.log(`db:admins: ${email}: ${answer}. ${NEXT[answer] ?? "La base contestó algo que este guion no conoce."}`);
}
const invited = answers.filter(({ answer }) => INVITED.has(answer)).length;
if (invited > 0) {
  console.log("db:admins: después de probar su buzón, al entrar se les pide configurar su segundo factor.");
  console.log("db:admins: esto dejó renglones en la auditoría. Antes de `pnpm test:db`, corre `pnpm db:reset`.");
}
if (invited !== answers.length) process.exit(1);
