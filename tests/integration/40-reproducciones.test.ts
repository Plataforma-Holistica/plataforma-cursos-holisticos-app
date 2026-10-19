import { generateKeyPairSync } from "node:crypto";

import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { signPlayback } from "@/adapters/mux/sign";
import { createMediaGrant } from "@/services/media/grant";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, type KnownUser, type MemoryJar } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { mediaStoreOn } from "./helpers/media";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Una reproducción a la vez (T-204; RF-107, FL-25), contra el Auth y la base locales: la guarda
// de sesión corre de verdad, y abrir y latir pasan por las funciones de la base a nombre de quien
// actúa y con la sesión de Auth de sus claims. Cada navegador es una entrada propia (otra sesión
// de Auth de la misma cuenta). El curso y la suscripción se escriben en una transacción del
// dueño que se revierte, como en 39-medios-ver.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = { id: "LlaveDePrueba01", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
const NOW = 1_800_000_000;

async function person(): Promise<KnownUser> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  return who;
}

/** Una entrada más de la misma persona: otro navegador, con su propia sesión de Auth. */
async function browserOf(who: KnownUser): Promise<MemoryJar> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return jar;
}

/** Un curso publicado y listado, con su lección de Mux, y una suscripción vigente para `profile`. */
async function setUp(owner: Client, profile: string): Promise<string> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de reproducir'), private.system_catalog_add('levels', 'Nivel de reproducir')");
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra que reproduce', 'maestra-reproduce', null)::text as id")).rows[0]?.id ?? "";
  const course = {
    slug: "curso-reproducir",
    title: "Yoga para reproducir",
    practice: "practica-de-reproducir",
    level: "nivel-de-reproducir",
    modules: [{ title: "Uno", lessons: [{ title: "Respirar", video: { provider: "mux", asset_id: "Asset-reproducir", playback_id: "Playback-reproducir", duration_seconds: 356 } }] }],
  };
  const loaded = (await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)])).rows[0];
  if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
  await owner.query(
    `update public.course_registry set state = 'published', first_published_at = now()
       where course_id = (select course_id from public.published_courses where slug = 'curso-reproducir')`,
  );
  await owner.query("update public.published_courses set is_listed = true where slug = 'curso-reproducir'");
  const lesson = (
    await owner.query<{ id: string }>(
      "select l.id::text as id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = 'curso-reproducir'",
    )
  ).rows[0]?.id;
  await asOwner(owner);
  await owner.query(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '10 days', now() + interval '20 days')`,
    [profile],
  );
  return lesson ?? "";
}

function mediaOn(owner: Client) {
  const reported: string[] = [];
  const media = createMediaGrant(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: testServices().teamStanding,
      checkSession: testServices().checkSession,
      store: mediaStoreOn(owner),
      signingKey: () => KEY,
      sign: signPlayback,
      now: () => NOW,
    },
  );
  return { ...media, reported };
}

async function granted(answer: Awaited<ReturnType<ReturnType<typeof mediaOn>["getMediaGrant"]>>) {
  if (answer.kind !== "granted") throw new Error(`No firmó: ${answer.kind}`);
  return answer;
}

describe("una reproducción a la vez", () => {
  it("abre al ver, con la sesión de Auth de ese navegador; otro navegador encuentra el lugar ocupado y la lista", async () => {
    const who = await person();
    const computer = await browserOf(who);
    const phone = await browserOf(who);
    await reverted(async (owner) => {
      const lesson = await setUp(owner, who.id);
      const media = mediaOn(owner);
      const first = await granted(await media.getMediaGrant(computer, lesson, "watch"));
      expect(first.heartbeatSeconds).toBe(30);
      const session = await testServices().checkSession(computer);
      if (session.kind !== "pass") throw new Error(`No pasó: ${session.kind}`);
      const row = (
        await owner.query<{ auth_session_id: string; access_basis: string; counts_for_payout: boolean; revoked_at: Date | null }>(
          "select auth_session_id::text, access_basis::text, counts_for_payout, revoked_at from public.playback_sessions where id = $1",
          [first.playbackSessionId],
        )
      ).rows[0];
      expect(row).toEqual({ auth_session_id: session.claims.sessionId, access_basis: "subscription", counts_for_payout: true, revoked_at: null });

      const busy = await media.getMediaGrant(phone, lesson, "watch");
      if (busy.kind !== "busy") throw new Error(`No dijo ocupado: ${busy.kind}`);
      expect(busy.live).toHaveLength(1);
      expect(busy.live[0]).toMatchObject({ sessionId: first.playbackSessionId, lessonTitle: "Respirar", courseTitle: "Yoga para reproducir" });
      expect(busy.live[0]?.device).toHaveProperty("browser");
      expect(media.reported).toEqual([]);
    });
  });

  it("renovar la dirección desde el mismo navegador nunca dice ocupado: reemplaza", async () => {
    const who = await person();
    const computer = await browserOf(who);
    await reverted(async (owner) => {
      const lesson = await setUp(owner, who.id);
      const media = mediaOn(owner);
      const first = await granted(await media.getMediaGrant(computer, lesson, "watch"));
      const again = await granted(await media.getMediaGrant(computer, lesson, "watch"));
      expect(again.playbackSessionId).not.toBe(first.playbackSessionId);
      expect(await media.playbackPresence(computer, first.playbackSessionId)).toEqual({ kind: "revoked", reason: "replaced", by: again.playbackSessionId });
      expect(await media.playbackPresence(computer, again.playbackSessionId)).toEqual({ kind: "ok" });
    });
  });

  it("cerrar la otra desde PA-34 abre esta en el mismo paso; la otra lo sabe en su latido, y puede tomarla de vuelta", async () => {
    const who = await person();
    const computer = await browserOf(who);
    const phone = await browserOf(who);
    await reverted(async (owner) => {
      const lesson = await setUp(owner, who.id);
      const media = mediaOn(owner);
      const first = await granted(await media.getMediaGrant(computer, lesson, "watch"));
      const second = await granted(await media.getMediaGrant(phone, lesson, "watch", { closing: first.playbackSessionId }));
      const closed = await media.playbackPresence(computer, first.playbackSessionId);
      expect(closed).toEqual({ kind: "revoked", reason: "closed_by_user", by: second.playbackSessionId });
      // «Reproducir aquí»: cierra la que tomó su lugar.
      const back = await granted(await media.getMediaGrant(computer, lesson, "watch", { closing: second.playbackSessionId }));
      expect(await media.playbackPresence(phone, second.playbackSessionId)).toEqual({ kind: "revoked", reason: "closed_by_user", by: back.playbackSessionId });
      // Un navegador no late la reproducción de otro, aunque sea de la misma cuenta.
      expect(await media.playbackPresence(phone, back.playbackSessionId)).toEqual({ kind: "refused" });
    });
  });

  it("el latido no mira el acceso: con el periodo vencido a media lección, sigue (decisión de T-202)", async () => {
    const who = await person();
    const computer = await browserOf(who);
    await reverted(async (owner) => {
      const lesson = await setUp(owner, who.id);
      const media = mediaOn(owner);
      const first = await granted(await media.getMediaGrant(computer, lesson, "watch"));
      await owner.query("update public.subscriptions set current_period_end = now() - interval '1 day', status = 'expired', ended_at = now() - interval '1 day' where profile_id = $1", [who.id]);
      expect(await media.playbackPresence(computer, first.playbackSessionId)).toEqual({ kind: "ok" });
      // Pedir otra vez sí lo mira.
      expect(await media.getMediaGrant(computer, lesson, "watch")).toMatchObject({ kind: "denied" });
    });
  });

  it("abrir espera el candado de la cuenta: dos peticiones a la vez no pasan las dos por el último lugar", async () => {
    const who = await person();
    const computer = await browserOf(who);
    const holder = new Client({ connectionString: localOwnerUrl() });
    await holder.connect();
    try {
      await reverted(async (owner) => {
        const lesson = await setUp(owner, who.id);
        const media = mediaOn(owner);
        // Otra conexión tiene el candado de esa cuenta, como lo tendría otra petición a la mitad.
        await holder.query("select pg_advisory_lock(hashtextextended('playback:' || $1, 0))", [who.id]);
        let settled = false;
        const opening = media.getMediaGrant(computer, lesson, "watch").finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        await holder.query("select pg_advisory_unlock(hashtextextended('playback:' || $1, 0))", [who.id]);
        expect(await opening).toMatchObject({ kind: "granted" });
      });
    } finally {
      await holder.end();
    }
  });

  it("cerrar la sesión mientras se abre: la apertura espera, y con la sesión ya cerrada no abre nada", async () => {
    const who = await person();
    const computer = await browserOf(who);
    const session = await testServices().checkSession(computer);
    if (session.kind !== "pass") throw new Error(`No pasó: ${session.kind}`);
    const closer = new Client({ connectionString: localOwnerUrl() });
    await closer.connect();
    try {
      await reverted(async (owner) => {
        const lesson = await setUp(owner, who.id);
        const media = mediaOn(owner);
        // Otra conexión cierra la sesión (lo que hacen close_session y compañía con lo anotado), sin confirmar todavía.
        await closer.query("begin");
        await closer.query("delete from private.app_sessions where session_id = $1", [session.claims.sessionId]);
        let settled = false;
        const opening = media.getMediaGrant(computer, lesson, "watch").finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        await closer.query("commit");
        // La guarda ya había pasado; la base ve la sesión cerrada y no anota nada: a la página.
        expect(await opening).toEqual({ kind: "refused" });
        expect((await owner.query<{ n: number }>("select count(*)::int as n from public.playback_sessions where profile_id = $1", [who.id])).rows[0]?.n).toBe(0);
        expect(media.reported).toEqual([]);
      });
    } finally {
      await closer.end();
    }
  });

  it("abrir y latir se niegan a correr con una foto fija: el candado no serviría", async () => {
    const who = await person();
    const client = new Client({ connectionString: localOwnerUrl() });
    await client.connect();
    try {
      for (const call of ["private.open_playback(gen_random_uuid(), 'x', 'subscription', true, null)", "private.touch_playback(gen_random_uuid())"]) {
        await client.query("begin isolation level repeatable read");
        // Como el servidor, dentro de esta transacción, que se revierte (como en `reverted`).
        await client.query("grant app_service to postgres with set true, inherit false");
        await asServer(client, who.id, crypto.randomUUID());
        await expect(client.query(`select ${call}`)).rejects.toMatchObject({ code: "25000" });
        await client.query("rollback");
      }
    } finally {
      await client.end();
    }
  });

  it("cerrar las demás sesiones desde la cuenta suelta el lugar al momento (FL-25, A2)", async () => {
    const who = await person();
    const computer = await browserOf(who);
    const phone = await browserOf(who);
    await reverted(async (owner) => {
      const lesson = await setUp(owner, who.id);
      const media = mediaOn(owner);
      const first = await granted(await media.getMediaGrant(computer, lesson, "watch"));
      expect(await media.getMediaGrant(phone, lesson, "watch")).toMatchObject({ kind: "busy" });
      // Lo que hace private.close_other_sessions() con lo anotado, dentro de esta transacción.
      const phoneSession = await testServices().checkSession(phone);
      if (phoneSession.kind !== "pass") throw new Error(`No pasó: ${phoneSession.kind}`);
      await owner.query("delete from private.app_sessions where profile_id = $1 and session_id <> $2", [who.id, phoneSession.claims.sessionId]);
      expect((await owner.query<{ reason: string }>("select revoke_reason as reason from public.playback_sessions where id = $1", [first.playbackSessionId])).rows[0]?.reason).toBe(
        "session_closed",
      );
      expect(await media.getMediaGrant(phone, lesson, "watch")).toMatchObject({ kind: "granted" });
    });
  });
});
