import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createAnomalyAlerts, type FinanceAlert } from "@/services/anomalies/alerts";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { anomalyStoreOn } from "./helpers/anomalies";
import { memoryJar, secondFactorFor, type KnownUser, type MemoryJar } from "./helpers/auth";
import { asOwner, asSystem, reverted, teamStoreOn } from "./helpers/team";
import { totpCode } from "./helpers/totp";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Las alertas de anomalía para finanzas y sus decisiones (PA-68 mínima; RF-406, RN-17; T-208),
// contra el Auth y la base locales: la guarda del equipo corre de verdad, y las alertas y las
// decisiones usan el mismo almacén que la aplicación, dentro de una transacción del dueño que se
// revierte (revisar y excluir escriben en tablas auditadas). Cada caso comprueba al final que la
// auditoría quedó como estaba y que no queda ninguna alerta. Qué decide la base con cada caso lo
// prueba `supabase/tests/30_alertas_lectura.test.sql`; aquí, que el servicio llega y lee bien.

const emails: string[] = [];
afterAll(async () => {
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

async function entered(person: KnownUser): Promise<MemoryJar> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, person, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return jar;
}

async function counts(): Promise<{ audit: number; alerts: number }> {
  const rows = await ownerQuery<{ audit: number; alerts: number }>(
    "select (select count(*)::int from public.audit_log) as audit, (select count(*)::int from public.anomaly_alerts) as alerts",
  );
  return rows[0] ?? { audit: -1, alerts: -1 };
}

/**
 * Una alumna con tres lecciones terminadas en el mes en curso, y la alerta de lecciones imposibles
 * que la corrida abriría con ellas, dentro de la transacción. Devuelve el id de la alerta.
 */
async function impossibleAlert(owner: Client, student: string): Promise<string> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de alertas'), private.system_catalog_add('levels', 'Nivel de alertas')");
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de alertas', 'maestra-alertas', null) as id")).rows[0]?.id;
  const course = {
    slug: "curso-alertas",
    title: "Curso de alertas",
    practice: "practica-de-alertas",
    level: "nivel-de-alertas",
    modules: [
      {
        title: "Uno",
        lessons: ["Uno", "Dos", "Tres"].map((title) => ({
          title,
          video: { provider: "mux", asset_id: `AssetAlertas${title}`, playback_id: `PlaybackAlertas${title}`, duration_seconds: 100 },
        })),
      },
    ],
  };
  const loaded = (await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)])).rows[0];
  if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
  await asOwner(owner);
  const period = (await owner.query<{ p: number }>("select to_char(timezone('America/Mexico_City', now()), 'YYYYMM')::int as p")).rows[0]!.p;
  await owner.query(
    `insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                      lesson_duration_seconds, covered_seconds, half_points)
     select $1, $2, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 100, 2
     from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = 'curso-alertas'`,
    [period, student],
  );
  // Diez segundos después de empezar el mes: tres lecciones de 100 s no caben ni a la velocidad máxima.
  await owner.query(
    "select private.detect_anomalies($1, timezone('America/Mexico_City', to_date($2 || '01', 'YYYYMMDD')::timestamp) + interval '10 seconds')",
    [period, String(period)],
  );
  const id = (await owner.query<{ id: string }>("select id::text from public.anomaly_alerts where profile_id = $1", [student])).rows[0]?.id;
  if (id === undefined) throw new Error("La corrida no abrió la alerta.");
  return id;
}

/** Alguien del equipo con esas capacidades y su código dado, y una alerta de una alumna, dentro de la transacción. */
async function staged<T>(capabilities: string[], fn: (stage: { owner: Client; jar: MemoryJar; person: KnownUser; student: KnownUser; alert: string }) => Promise<T>) {
  const person = await claimedUser();
  const student = await claimedUser();
  emails.push(person.email, student.email);
  await completeAccountAsOwner(person.id);
  await completeAccountAsOwner(student.id, "Alumna Señalada");
  const factor = await secondFactorFor(person);
  const jar = await entered(person);
  const before = await counts();
  const result = await reverted(async (owner) => {
    const services = testServices({ teamStore: teamStoreOn(owner) });
    await asSystem(owner);
    for (const capability of capabilities) {
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2::public.capability)", [person.id, capability]);
    }
    await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
      person.id,
      factor.factorId,
      person.email.toLowerCase(),
    ]);
    await asOwner(owner);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    const alert = await impossibleAlert(owner, student.id);
    return fn({ owner, jar, person, student, alert });
  });
  expect(await counts()).toEqual(before);
  return result;
}

function alertsOn(owner: Client) {
  const services = testServices({ teamStore: teamStoreOn(owner) });
  const reported: string[] = [];
  const alerts = createAnomalyAlerts(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    { teamStanding: services.teamStanding, giveSecondFactorCode: services.giveSecondFactorCode, store: anomalyStoreOn(owner) },
  );
  return { ...alerts, reported, services };
}

async function read(service: ReturnType<typeof alertsOn>, jar: MemoryJar): Promise<{ freshCode: boolean; alerts: FinanceAlert[] }> {
  const check = await service.services.teamStanding(jar);
  if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");
  const result = await service.anomalyAlerts(jar, check.claims);
  if (result.kind !== "alerts") throw new Error("No leyó las alertas.");
  return result.alerts;
}

describe("las alertas y las decisiones de finanzas, contra la base", () => {
  it("con Finanzas y su código: lee la alerta sin nada que identifique a la alumna, la revisa, decide fraude, excluye y revierte", async () => {
    await staged(["finance"], async ({ owner, jar, student, alert }) => {
      const service = alertsOn(owner);
      const first = await read(service, jar);
      expect(first.freshCode).toBe(true);
      const card = first.alerts.find((each) => each.id === alert);
      expect(card).toMatchObject({ kind: "impossible_completion", status: "open", canExclude: true, teacherName: null, moreAccounts: 0 });
      expect(card?.accounts).toHaveLength(1);
      const account = card?.accounts[0]?.account ?? "";
      expect(account).toMatch(/^[0-9a-f]{12}$/);
      expect(card?.accounts[0]).toMatchObject({ age: "under_7", lessons: 3, coveredSeconds: 300, excluded: false });
      // Nada de lo leído nombra a la alumna: ni su identificador, ni su correo, ni su nombre.
      const served = JSON.stringify(first);
      for (const secret of [student.id, student.email, "Alumna Señalada"]) expect(served).not.toContain(secret);

      expect(await service.reviewAlert(jar, { alert, note: "Lo revisé con el consolidado." })).toEqual({ kind: "answered", answer: "reviewed" });
      expect(await service.reviewAlert(jar, { alert, note: "Otra vez." })).toEqual({ kind: "answered", answer: "already_reviewed" });
      // Sin fraude decidido, excluir por fraude no pasa.
      expect(await service.excludeAccount(jar, { alert, account, reasonCode: "fraud", reason: "Tres lecciones en diez segundos." })).toEqual({
        kind: "answered",
        answer: "needs_fraud_decision",
      });
      expect(await service.decideFraud(jar, { alert, evidence: "Tres lecciones en diez segundos." })).toEqual({ kind: "answered", answer: "marked_fraud" });
      expect(await service.excludeAccount(jar, { alert, account, reasonCode: "fraud", reason: "Tres lecciones en diez segundos." })).toEqual({
        kind: "answered",
        answer: "excluded",
      });

      const second = (await read(service, jar)).alerts.find((each) => each.id === alert);
      expect(second).toMatchObject({ status: "reviewed", isFraud: true, reviewNote: "Lo revisé con el consolidado." });
      expect(second?.accounts[0]).toMatchObject({ account, excluded: true });
      expect(second?.exclusions).toHaveLength(1);
      const exclusion = second?.exclusions[0];
      expect(exclusion).toMatchObject({ account, scope: "account", reasonCode: "fraud", revokedAt: null });
      // La exclusión marca los pares de la alumna para la consolidación.
      const marked = await owner.query<{ n: number }>("select count(*)::int as n from private.rollup_dirty where profile_id = $1", [student.id]);
      expect(marked.rows[0]?.n).toBe(3);

      expect(await service.revokeExclusion(jar, { exclusion: exclusion?.id, reason: "Era un error de la prueba." })).toEqual({
        kind: "answered",
        answer: "revoked",
      });
      expect(await service.revokeExclusion(jar, { exclusion: exclusion?.id, reason: "Otra vez." })).toEqual({ kind: "answered", answer: "already_revoked" });
      const third = (await read(service, jar)).alerts.find((each) => each.id === alert);
      expect(third?.accounts[0]?.excluded).toBe(false);
      expect(third?.exclusions[0]?.revokeReason).toBe("Era un error de la prueba.");
      expect(service.reported).toEqual([]);
    });
  });

  it("una huella que no es de la alerta no excluye a nadie", async () => {
    await staged(["finance"], async ({ owner, jar, alert }) => {
      const service = alertsOn(owner);
      expect(await service.excludeAccount(jar, { alert, account: "0123456789ab", reasonCode: "other", reason: "Una prueba." })).toEqual({
        kind: "answered",
        answer: "not_found",
      });
      expect(await service.excludeAccount(jar, { alert: "00000000-0000-4000-8000-000000000000", account: "0123456789ab", reasonCode: "other", reason: "Una prueba." })).toEqual({
        kind: "answered",
        answer: "not_found",
      });
    });
  });

  it("con el código vencido: las alertas se leen, y decidir pide darlo otra vez sin escribir nada", async () => {
    await staged(["finance"], async ({ owner, jar, person, alert }) => {
      const service = alertsOn(owner);
      await owner.query(
        `update auth.mfa_amr_claims c set updated_at = now() - interval '1 hour'
         from auth.sessions s where c.session_id = s.id and s.user_id = $1`,
        [person.id],
      );
      const alerts = await read(service, jar);
      expect(alerts.freshCode).toBe(false);
      expect(await service.reviewAlert(jar, { alert, note: "Lo revisé." })).toEqual({ kind: "answered", answer: "needs_fresh_code" });
      const status = await owner.query<{ status: string }>("select status::text from public.anomaly_alerts where id = $1", [alert]);
      expect(status.rows[0]?.status).toBe("open");
    });
  });

  it("del equipo sin Finanzas: decidir contesta refused, y la lectura, por debajo de la guarda, es nula", async () => {
    await staged(["content"], async ({ owner, jar, alert }) => {
      const service = alertsOn(owner);
      expect(await service.reviewAlert(jar, { alert, note: "Lo revisé." })).toEqual({ kind: "refused" });
      expect(await service.excludeAccount(jar, { alert, account: "0123456789ab", reasonCode: "other", reason: "Una prueba." })).toEqual({ kind: "refused" });
      const check = await service.services.teamStanding(jar);
      if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");
      expect(await anomalyStoreOn(owner).alerts(check.claims)).toBeNull();
      expect(await service.anomalyAlerts(jar, check.claims)).toEqual({ kind: "unavailable" });
      // La guarda tampoco la deja pasar: no se reporta.
      expect(service.reported).toEqual([]);
    });
  });
});
