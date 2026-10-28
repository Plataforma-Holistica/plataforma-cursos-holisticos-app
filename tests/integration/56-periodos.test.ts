import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPeriodsPanel } from "@/services/periods/panel";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, secondFactorFor, type KnownUser, type MemoryJar } from "./helpers/auth";
import { periodStoreOn } from "./helpers/period-store";
import { asOwner, asSystem, reverted, teamStoreOn } from "./helpers/team";
import { totpCode } from "./helpers/totp";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// El servicio de los periodos (PA-78 a PA-80; T-605) contra el Auth y la base locales: la guarda del
// equipo corre de verdad, y las lecturas y las decisiones usan el mismo almacén que la aplicación, dentro
// de una transacción del dueño que se revierte (ensayar, cerrar y descargar escriben en tablas que no
// admiten borrado). Lo que se prueba aquí es que el servicio llega y lee bien: que los esquemas estrictos
// aceptan lo que la base contesta de verdad, abierto, en cierre, ensayado y cerrado. Qué decide la base lo
// prueban `supabase/tests/51` a `53`, y el cierre confirmado de verdad, `54-panel-del-periodo.test.ts`.
//
// Usa enero de 2039, que ninguna otra prueba usa. Dentro de la transacción quita las filas abiertas desde
// el arranque a las que nada apunta (cerrar va en orden), y exige que no quede ninguna otra.

const PERIOD = 203901;
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

const counts = async () =>
  (await ownerQuery<{ audit: number; runs: number; exports: number }>(
    `select (select count(*)::int from public.audit_log) as audit, (select count(*)::int from public.close_runs) as runs,
            (select count(*)::int from private.close_exports) as exports`,
  ))[0];

/** Enero de 2039 en cierre, con un alumno que pagó y vio a dos maestros, y su consolidación completa. */
async function closingPeriod(owner: Client, student: string): Promise<void> {
  await asOwner(owner);
  await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
  await owner.query(
    `delete from public.payout_periods p
     where p.status = 'open' and p.period_id < $1
       and p.period_id >= (select min(effective_period_id) from public.pool_tiers where canceled_at is null)
       and not exists (select 1 from public.charges c where c.allocation_start_period_id = p.period_id)
       and not exists (select 1 from public.watch_rollup w where w.period_id = p.period_id)
       and not exists (select 1 from public.anomaly_alerts a where a.period_id = p.period_id)
       and not exists (select 1 from public.close_runs r where r.period_id = p.period_id)
       and not exists (select 1 from private.rollup_requests q where q.period_id = p.period_id)`,
    [PERIOD],
  );
  const before = await owner.query(
    `select 1 from public.payout_periods where status in ('open', 'closing') and period_id < $1
       and period_id >= (select min(effective_period_id) from public.pool_tiers where canceled_at is null)`,
    [PERIOD],
  );
  if ((before.rowCount ?? 0) > 0) throw new Error("hay periodos abiertos desde el arranque en la base local: pnpm db:reset");
  await asSystem(owner);
  await owner.query("select private.open_period($1)", [PERIOD]);
  await owner.query(
    "update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 1, pool_bps = 6000 where period_id = $1",
    [PERIOD],
  );
  await owner.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
  await owner.query(
    `insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
     values ('nightly_rollup', $1, 'succeeded', now() - interval '1 hour', now() - interval '1 hour', now() - interval '59 minutes', '{"mode": "full"}')`,
    [PERIOD],
  );
  // El cobro, su asignación, los maestros y el consumo, sin guardias ni claves, como en la 54.
  await owner.query("set local session_replication_role = replica");
  const charge = randomUUID();
  await owner.query(
    `insert into public.charges (id, profile_id, subscription_id, provider, provider_charge_id, plan, charged_at, period_id,
                                 allocation_start_period_id, currency, gross_cents, tax_cents, fx_rate_to_mxn, fx_source, gross_mxn_cents,
                                 net_of_tax_mxn_cents, iva_bps, fee_bps, revenue_net_mxn_cents, payment_method, country_code)
     values ($1, $2, gen_random_uuid(), 'manual', $3, 'monthly', now(), $4, $4, 'MXN', 34900, 4814, 1, 'same_currency', 34900, 30086, 1600, 500, 28581,
             'card', 'MX')`,
    [charge, student, `it-${charge}`, PERIOD],
  );
  await owner.query(
    `insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
     values ($1, $2, $3, 'charge', 1, 1, 28581, 500, 'charge_date_v1')`,
    [charge, student, PERIOD],
  );
  for (const [n, name] of ["Maestra Periodos Uno", "Maestra Periodos Dos"].entries()) {
    const teacher = (await owner.query<{ id: string }>("insert into public.teachers (status) values ('invited') returning id::text")).rows[0]!.id;
    await owner.query("insert into public.published_teachers (teacher_id, slug, display_name) values ($1, $2, $3)", [teacher, `it-periodos-${teacher.slice(0, 8)}`, name]);
    await owner.query(
      `insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                        lesson_duration_seconds, covered_seconds, half_points)
       values ($1, $2, gen_random_uuid(), gen_random_uuid(), $3, gen_random_uuid(), 100, 100, $4)`,
      [PERIOD, student, teacher, n + 1],
    );
  }
  await owner.query("set local session_replication_role = origin");
  await asOwner(owner);
}

/** Alguien del equipo con esas capacidades y su código dado, y enero de 2039 en cierre, dentro de la transacción. */
async function staged<T>(capabilities: string[], fn: (stage: { owner: Client; jar: MemoryJar; student: KnownUser }) => Promise<T>) {
  const person = await claimedUser();
  const student = await claimedUser();
  emails.push(person.email, student.email);
  await completeAccountAsOwner(person.id);
  await completeAccountAsOwner(student.id, "Alumno del Cierre");
  const factor = await secondFactorFor(person);
  const jar = await entered(person);
  const before = await counts();
  const result = await reverted(async (owner) => {
    const services = testServices({ teamStore: teamStoreOn(owner) });
    await asSystem(owner);
    for (const capability of capabilities) {
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2::public.capability)", [person.id, capability]);
    }
    await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [person.id, factor.factorId, person.email.toLowerCase()]);
    await asOwner(owner);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    await closingPeriod(owner, student.id);
    return fn({ owner, jar, student });
  });
  expect(await counts()).toEqual(before);
  return result;
}

function periodsOn(owner: Client) {
  const services = testServices({ teamStore: teamStoreOn(owner) });
  const reported: string[] = [];
  const panel = createPeriodsPanel(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    { teamStanding: services.teamStanding, giveSecondFactorCode: services.giveSecondFactorCode, store: periodStoreOn(owner) },
  );
  return { ...panel, reported, services };
}

async function claimsOf(service: ReturnType<typeof periodsOn>, jar: MemoryJar) {
  const check = await service.services.teamStanding(jar);
  if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");
  return check.claims;
}

describe("los periodos, el ensayo y el cierre, contra la base", () => {
  it("con finanzas y su código: lee, ensaya, no deja ensayar otra vez en el mismo minuto, cierra, lee lo cerrado y descarga", async () => {
    await staged(["finance"], async ({ jar, owner, student }) => {
      const service = periodsOn(owner);
      const claims = await claimsOf(service, jar);

      const list = await service.financePeriods(jar, claims);
      expect(list.kind).toBe("periods");
      if (list.kind !== "periods") return;
      expect(list.periods.freshCode).toBe(true);
      expect(list.periods.periods.find((row) => row.periodId === PERIOD)).toMatchObject({ status: "closing", activeStudents: null, rehearsedAt: null });

      const panel = await service.financePeriod(jar, claims, PERIOD);
      expect(panel).toMatchObject({
        kind: "period",
        period: {
          period: { periodId: PERIOD, status: "closing", activeStudents: 1, poolBps: 6000 },
          collected: { charges: 1, grossCents: 34900, netCents: 28581 },
          assigned: { students: 1, baseCents: 28581 },
          close: null,
          rehearsal: null,
          openAlerts: 0,
          lastRollup: { status: "succeeded", mode: "full" },
          rollupRequest: null,
        },
      });

      // Enero de 2039 está fuera de la ventana de la consolidación: no se recalcula.
      expect(await service.requestRollup(jar, { period: PERIOD })).toEqual({ kind: "answered", answer: "not_rollable" });
      // Sin ensayo con datos finales, no cierra.
      expect(await service.closePeriod(jar, { period: PERIOD })).toEqual({ kind: "answered", answer: "rehearsal_missing" });

      expect(await service.rehearse(jar, { period: PERIOD })).toEqual({ kind: "answered", answer: "rehearsed" });
      expect(await service.rehearse(jar, { period: PERIOD })).toEqual({ kind: "answered", answer: "too_soon" });

      const rehearsed = await service.financeClose(jar, claims, PERIOD);
      expect(rehearsed.kind).toBe("close");
      if (rehearsed.kind !== "close" || rehearsed.close.period === null) return;
      expect(rehearsed.close.checks).toEqual({ openAlerts: 0, finalRehearsal: true, lastRollup: "succeeded", rollupMarks: false });
      expect(rehearsed.close.rehearsal).toMatchObject({ status: "succeeded", statusAtRun: "closing", poolBps: 6000 });
      expect(rehearsed.close.rehearsal?.teachers.map((row) => row.name)).toEqual(["Maestra Periodos Dos", "Maestra Periodos Uno"]);
      const shared = rehearsed.close.rehearsal?.teachers.reduce((sum, row) => sum + row.totalCents, 0);
      expect(shared).toBe((rehearsed.close.rehearsal?.poolCents ?? 0) - (rehearsed.close.rehearsal?.carriedOutCents ?? 0));

      expect(await service.closePeriod(jar, { period: PERIOD })).toEqual({ kind: "answered", answer: "closed" });
      expect(await service.closePeriod(jar, { period: PERIOD })).toEqual({ kind: "answered", answer: "already_closed" });

      const closed = await service.financeClose(jar, claims, PERIOD);
      if (closed.kind !== "close" || closed.close.period === null) throw new Error("No leyó el cierre.");
      expect(closed.close.period.status).toBe("closed");
      expect(closed.close.close).toMatchObject({ export: { rows: 2 } });
      expect(closed.close.close?.teachers.every((row) => row.belowMinimum !== null)).toBe(true);
      const runId = closed.close.close!.runId;

      const file = await service.downloadExport(jar, { run: runId });
      expect(file).toMatchObject({ kind: "file", file: { filename: "cierre-2039-01.csv", rows: 2 } });
      if (file.kind !== "file") return;
      expect(file.file.content.startsWith("﻿periodo,")).toBe(true);
      expect(file.file.sha256).toBe(closed.close.close?.export?.sha256);
      // Nada de lo leído nombra al alumno.
      const served = JSON.stringify([list, panel, rehearsed, closed, file]);
      for (const secret of [student.id, student.email, "Alumno del Cierre"]) expect(served).not.toContain(secret);
      expect(await service.downloadExport(jar, { run: randomUUID() })).toEqual({ kind: "answered", answer: "not_found" });

      const after = await service.financePeriod(jar, claims, PERIOD);
      expect(after).toMatchObject({ kind: "period", period: { period: { status: "closed" }, close: { runId } } });
      expect(service.reported).toEqual([]);
    });
  });

  it("un periodo que la base no tiene: no existe", async () => {
    await staged(["finance"], async ({ jar, owner }) => {
      const service = periodsOn(owner);
      const claims = await claimsOf(service, jar);
      expect(await service.financePeriod(jar, claims, 203912)).toEqual({ kind: "not_found" });
      expect(await service.financeClose(jar, claims, 203912)).toEqual({ kind: "not_found" });
    });
  });

  it("sin finanzas: las decisiones no llegan a la base, y las lecturas no se le contestan", async () => {
    await staged(["content"], async ({ jar, owner }) => {
      const service = periodsOn(owner);
      const claims = await claimsOf(service, jar);
      expect(await service.rehearse(jar, { period: PERIOD })).toEqual({ kind: "refused" });
      expect(await service.closePeriod(jar, { period: PERIOD })).toEqual({ kind: "refused" });
      expect(await service.financePeriods(jar, claims)).toEqual({ kind: "unavailable" });
      expect(service.reported).toEqual([]);
    });
  });
});
