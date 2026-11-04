import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createPayoutReports } from "@/services/teachers/payout-report";
import { askPayoutReport, askPayoutReportCsv, askPayoutsMine } from "@/services/teachers/payout-report-records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { connect, waitBehind } from "./helpers/finance";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// El reporte del maestro (T-604, cuarta solicitud) contra la base y el Auth locales. Dos partes.
//
// El camino, por el servicio: dos maestros con un alumno en común leen sus liquidaciones, el reporte del mismo periodo y su CSV, y cada uno ve solo lo suyo,
// con alias y puntos. Todo vive en una transacción del dueño que se revierte.
//
// Y lo que una transacción revertida no puede mostrar: dos lecturas a la vez del mismo maestro crean los alias una sola vez. Usa enero de 2044, que ninguna
// otra prueba usa, armado con las guardias apagadas, y al terminar se quita de la misma manera. Para eso el dueño toma el rol del servidor y lo suelta.

const emails: string[] = [];

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

type Person = { id: string; jar: ReturnType<typeof memoryJar>; claims: VerifiedClaims };

async function person(): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, jar, claims: check.claims };
}

async function student(): Promise<string> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  return who.id;
}

async function teacher(owner: Client, who: { id: string }): Promise<string> {
  await asSystem(owner);
  const id = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id::text", [who.id])).rows[0]!.id;
  await asOwner(owner);
  return id;
}

/** Un periodo cerrado y liberado sin pasar por el cierre, con lo que el cierre deja de cada pareja de alumno y maestro. */
async function closedPeriod(
  owner: Client,
  period: number,
  by: string,
  shares: { profile: string; teacher: string; half: number; cents: number }[],
): Promise<string> {
  await owner.query("set local session_replication_role = replica");
  const run = randomUUID();
  await owner.query(
    `insert into public.close_runs (id, period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
     values ($1, $2, 'rehearsal', 'failed', 'open', 'prueba', '{}', $3, 'prueba')`,
    [run, period, by],
  );
  await owner.query(
    `insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status, entered_closing_at, active_students, pool_bps, net_revenue_cents,
                                        student_pools_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents, close_run_id, closed_at, closed_by,
                                        payouts_released_at, payouts_released_by)
     select $1, b.starts_at, b.ends_at, 'America/Mexico_City', 'closed', now(), 2, 6000, 60000, 36000, 36000, 30000, 6000, 0, $2, now(), $3, now(), $3
     from private.month_bounds($1, 'America/Mexico_City') b`,
    [period, run, by],
  );
  for (const profile of new Set(shares.map((s) => s.profile))) {
    await owner.query(
      `insert into public.payout_student_pools (period_id, profile_id, close_run_id, base_cents, pool_cents, half_points) values ($1, $2, $3, 30000, 18000, 10)`,
      [period, profile, run],
    );
  }
  for (const s of shares) {
    await owner.query(
      `insert into public.payout_shares (period_id, profile_id, teacher_id, close_run_id, half_points, amount_cents) values ($1, $2, $3, $4, $5, $6)`,
      [period, s.profile, s.teacher, run, s.half, s.cents],
    );
  }
  for (const t of new Set(shares.map((s) => s.teacher))) {
    const mine = shares.filter((s) => s.teacher === t);
    const assigned = mine.reduce((sum, s) => sum + s.cents, 0);
    await owner.query(
      `insert into public.payout_teacher_totals (period_id, teacher_id, close_run_id, half_points, students, assigned_cents, unconsumed_cents, total_cents)
       values ($1, $2, $3, $4, $5, $6::bigint, 1000, $6::bigint + 1000)`,
      [period, t, run, mine.reduce((sum, s) => sum + s.half, 0), mine.length, assigned],
    );
    await owner.query(
      `insert into public.payouts (period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, net_cents)
       values ($1, $2, $3, 'calculated', $4::bigint + 1000, $4::bigint + 1000, $4::bigint + 1000)`,
      [period, t, run, assigned],
    );
  }
  await owner.query("set local session_replication_role = origin");
  return run;
}

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

async function asServerFor<T>(owner: Client, claims: VerifiedClaims, work: (tx: Tx) => Promise<T>): Promise<T> {
  const { claims: verified } = readVerifiedClaims(claims);
  await asServer(owner, verified.userId, verified.sessionId ?? "");
  try {
    return await work(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

function serviceOn(owner: Client) {
  return createPayoutReports({
    store: {
      mine: (claims) => asServerFor(owner, claims, askPayoutsMine),
      report: (claims, period) => asServerFor(owner, claims, (tx) => askPayoutReport(tx, period)),
      csv: (claims, period) => asServerFor(owner, claims, (tx) => askPayoutReportCsv(tx, period)),
    },
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.resolve(),
  });
}

describe("por el servicio", () => {
  it("cada maestro ve sus liquidaciones y su reporte, con alias y puntos, y nada del otro", async () => {
    const ana = await person();
    const beto = await person();
    const [s1, s2] = [await student(), await student()];
    await reverted(async (owner) => {
      const anaT = await teacher(owner, ana);
      const betoT = await teacher(owner, beto);
      await closedPeriod(owner, 204312, ana.id, [
        { profile: s1, teacher: anaT, half: 5, cents: 12000 },
        { profile: s2, teacher: anaT, half: 2, cents: 8000 },
        { profile: s1, teacher: betoT, half: 4, cents: 10000 },
      ]);
      const service = serviceOn(owner);

      const mine = await service.myPayouts(ana.claims);
      expect(mine).toEqual({
        kind: "ready",
        value: {
          outcome: "ok",
          value: {
            balanceCents: null,
            receiverReady: false,
            periods: [
              {
                period: "2043-12", status: "calculated", poolCents: 21000, bonusesCents: null, adjustmentsCents: null, balanceAppliedCents: null, netCents: null,
                carriedCents: null, invoiceDueOn: null, overdue: false, action: null,
              },
            ],
          },
        },
      });

      const report = await service.payoutReport(ana.claims, "2043-12");
      if (report.kind !== "ready" || report.value.outcome !== "ok") throw new Error("Ana no tiene reporte");
      const anaRows = report.value.value.students;
      expect(anaRows.map((r) => r.halfPoints)).toEqual([5, 2]);
      expect(anaRows.every((r) => /^[A-Z][a-z]+ [1-9][0-9]{1,3}$/.test(r.alias))).toBe(true);
      expect(report.value.value.summary).toMatchObject({ assignedCents: 20000, unconsumedCents: 1000, totalCents: 21000, halfPoints: 7, students: 2 });
      expect(report.value.value.money).toBeNull();
      // Nada en la respuesta nombra a un alumno.
      expect(JSON.stringify(report)).not.toContain(s1);

      const betoReport = await service.payoutReport(beto.claims, "2043-12");
      if (betoReport.kind !== "ready" || betoReport.value.outcome !== "ok") throw new Error("Beto no tiene reporte");
      expect(betoReport.value.value.students.map((r) => r.halfPoints)).toEqual([4]);
      expect(betoReport.value.value.summary.totalCents).toBe(11000);

      const csv = await service.payoutReportCsv(ana.jar, "2043-12");
      if (csv.kind !== "csv") throw new Error(`sin CSV: ${csv.kind}`);
      expect(csv.fileName).toBe("reporte-2043-12.csv");
      expect(csv.text).toBe(
        `﻿"Alumno","Puntos","Pesos"\r\n"${anaRows[0]!.alias}",2.5,\r\n"${anaRows[1]!.alias}",1,\r\n"Bote sin consumo",,10.00\r\n"Total",3.5,210.00\r\n`,
      );
      expect(await service.payoutReport(ana.claims, "2043-11")).toEqual({ kind: "ready", value: { outcome: "not_found" } });
    });
  });
});

describe("dos lecturas a la vez", () => {
  it("crean los alias del maestro una sola vez", async () => {
    const ana = await person();
    const students = [await student(), await student(), await student()];
    const PERIOD = 204401;
    const setup = await connect();
    let anaT = "";
    try {
      await setup.query("begin");
      anaT = await teacher(setup, ana);
      await closedPeriod(setup, PERIOD, ana.id, students.map((profile, i) => ({ profile, teacher: anaT, half: 2 + i, cents: 1000 * (i + 1) })));
      // Las dos conexiones confirman como el servidor: el dueño toma su rol, sin heredarlo, y lo suelta al terminar (como la 54).
      await setup.query("grant app_service to postgres with set true, inherit false");
      await setup.query("commit");

      const [first, second] = [await connect(), await connect()];
      try {
        const read = async (client: Client) => {
          await client.query("begin");
          return asServerFor(client, ana.claims, (tx) => askPayoutReport(tx, PERIOD));
        };
        const one = await read(first);
        const twoPending = read(second);
        await waitBehind(setup, first, 1);
        await first.query("commit");
        const two = await twoPending;
        await second.query("commit");
        if (one.outcome !== "ok" || two.outcome !== "ok") throw new Error("sin reporte");
        expect(two.value.students).toEqual(one.value.students);
        const count = (await setup.query<{ n: number }>("select count(*)::int as n from private.student_aliases where teacher_id = $1", [anaT])).rows[0]!.n;
        expect(count).toBe(3);
      } finally {
        await first.end();
        await second.end();
      }
    } finally {
      await setup.query("rollback").catch(() => undefined);
      await setup.query("revoke app_service from postgres");
      await setup.query("begin");
      await setup.query("set local session_replication_role = replica");
      if (anaT !== "") {
        await setup.query("delete from private.student_aliases where teacher_id = $1", [anaT]);
        await setup.query("delete from public.payouts where period_id = $1", [PERIOD]);
        await setup.query("delete from public.payout_teacher_totals where period_id = $1", [PERIOD]);
        await setup.query("delete from public.payout_shares where period_id = $1", [PERIOD]);
        await setup.query("delete from public.payout_student_pools where period_id = $1", [PERIOD]);
        await setup.query("delete from public.payout_periods where period_id = $1", [PERIOD]);
        await setup.query("delete from public.close_runs where period_id = $1", [PERIOD]);
        await setup.query("delete from public.teachers where id = $1", [anaT]);
      }
      await setup.query("commit");
      await setup.end();
    }
  });
});
