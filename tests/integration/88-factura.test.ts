import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createInvoiceStorage } from "@/adapters/supabase/storage";
import { createInvoiceFiles } from "@/services/media/invoice-files";
import { askInvoiceBegin, askInvoiceCancel, askInvoiceFile, askInvoiceReview, askInvoiceSubmit, askInvoiceUnused, askInvoiceUpload } from "@/services/teachers/invoice-records";
import { createInvoices } from "@/services/teachers/invoices";
import { createTaxCipher } from "@/services/teachers/tax-cipher";
import { askTaxMine } from "@/services/teachers/tax-records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { connect, waitBehind } from "./helpers/finance";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// La factura del maestro (T-604, tercera solicitud) contra la base, el Auth y el Storage locales. Dos partes.
//
// El camino, por el servicio: empezar, subir el PDF del navegador a la cubeta con la dirección firmada, mandar el XML y bajar los dos. Los maestros y las
// liquidaciones viven en una transacción del dueño que se revierte; los objetos no (los escribe Storage con su propia conexión), y se borran al terminar.
//
// Y lo que una transacción revertida no puede mostrar: dos subidas a la vez de la misma liquidación, y el mismo folio fiscal en dos liquidaciones a la vez.
// Usan meses de 2043, que ninguna otra prueba usa, armados con las guardias apagadas, y al terminar se quitan de la misma manera; la auditoría se queda.

const emails: string[] = [];
const uploaded: string[] = [];
const storage = createInvoiceStorage();

afterAll(async () => {
  await storage.remove(uploaded);
  await deleteTestUsersByEmail(emails);
});

const keys = (() => {
  const raw = randomBytes(32);
  return `1:${raw.toString("base64")}:${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
})();
const cipher = createTaxCipher(() => ({ keys, active: "1" }));
const RFC = "GOMA800101AB1";
const RECEIVER = "PHO200101AB1";
const PDF = Buffer.from("%PDF-1.7\nuna factura\n%%EOF\n", "latin1");

const xmlOf = (uuid: string, rfc = RFC, vat = "160.00") => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="1" Fecha="2026-11-03T10:00:00" SubTotal="1000.00" Moneda="MXN"
  Total="953.33" TipoDeComprobante="I" MetodoPago="PUE">
  <cfdi:Emisor Rfc="${rfc}" Nombre="ANA GÓMEZ" RegimenFiscal="612"/>
  <cfdi:Receptor Rfc="${RECEIVER}" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Impuestos TotalImpuestosRetenidos="206.67" TotalImpuestosTrasladados="${vat}">
    <cfdi:Retenciones><cfdi:Retencion Impuesto="001" Importe="100.00"/><cfdi:Retencion Impuesto="002" Importe="106.67"/></cfdi:Retenciones>
    <cfdi:Traslados><cfdi:Traslado Impuesto="002" TipoFactor="Tasa" Importe="${vat}"/></cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}" FechaTimbrado="2026-11-03T10:01:00"/></cfdi:Complemento>
</cfdi:Comprobante>`;

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

/** Un maestro con sus datos fiscales: el RFC, cifrado de verdad con la llave de la prueba. */
async function teacher(owner: Client, who: { id: string }, status: "active" | "suspended" = "active"): Promise<string> {
  await asSystem(owner);
  const id = (
    await owner.query<{ id: string }>(
      `insert into public.teachers (profile_id, status, suspended_at, suspension_reason)
       values ($1, $2::public.teacher_status, case when $3 then now() end, case when $3 then 'prueba' end) returning id::text`,
      [who.id, status, status === "suspended"],
    )
  ).rows[0]!.id;
  await owner.query("set local session_replication_role = replica");
  await owner.query(
    `insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version,
                                               created_by, clabe_changed_at, clabe_effective_from)
     values ($1, 1, $2, $3, '612', 'person', decode('010001' || repeat('ab', 46), 'hex'), '7771', 1, $4, now() - interval '10 days', now() - interval '7 days')`,
    [id, cipher.seal({ teacher: id, rowVersion: 1, field: "rfc" }, RFC), cipher.seal({ teacher: id, rowVersion: 1, field: "legal_name" }, "Ana Gómez"), who.id],
  );
  await owner.query("set local session_replication_role = origin");
  await asOwner(owner);
  return id;
}

/** Una liquidación de honorarios de 1 000 pesos que espera factura, en un periodo cerrado y liberado sin pasar por el cierre. */
async function payout(owner: Client, teacherId: string, period: number, by: string): Promise<string> {
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
     select $1, b.starts_at, b.ends_at, 'America/Mexico_City', 'closed', now(), 0, 6000, 0, 0, 0, 0, 0, 0, $2, now(), $3, now(), $3
     from private.month_bounds($1, 'America/Mexico_City') b`,
    [period, run, by],
  );
  const id = (
    await owner.query<{ id: string }>(
      `insert into public.payouts (period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, vat_cents, income_tax_withheld_cents,
                                   vat_withheld_cents, net_cents, released_at, released_by, invoice_due_on)
       values ($1, $2, $3, 'awaiting_invoice', 100000, 100000, 16000, 10000, 10667, 95333, now(), $4, current_date + 30) returning id::text`,
      [period, teacherId, run, by],
    )
  ).rows[0]!.id;
  await owner.query("set local session_replication_role = origin");
  return id;
}

async function receiver(owner: Client, rfc: string): Promise<void> {
  await owner.query("set local session_replication_role = replica");
  await owner.query("update public.business_parameters set value = to_jsonb($1::text) where key = 'RFC_RECEPTOR'", [rfc]);
  await owner.query("set local session_replication_role = origin");
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

function serviceOn(owner: Client, reported: string[] = []) {
  return createInvoices({
    store: {
      begin: (claims, id, seen) => asServerFor(owner, claims, (tx) => askInvoiceBegin(tx, id, seen)),
      upload: (claims, invoice) => asServerFor(owner, claims, (tx) => askInvoiceUpload(tx, invoice)),
      submit: (claims, seal) => asServerFor(owner, claims, (tx) => askInvoiceSubmit(tx, seal)),
      cancel: (claims, invoice) => asServerFor(owner, claims, (tx) => askInvoiceCancel(tx, invoice)),
      review: (claims, invoice, decision) => asServerFor(owner, claims, (tx) => askInvoiceReview(tx, invoice, decision)),
      file: (claims, invoice, kind) => asServerFor(owner, claims, (tx) => askInvoiceFile(tx, invoice, kind)),
      unused: (claims, id) => asServerFor(owner, claims, (tx) => askInvoiceUnused(tx, id)),
    },
    files: createInvoiceFiles(storage),
    mine: (claims) => asServerFor(owner, claims, askTaxMine),
    cipher,
    checkSession: (reader) => testServices().checkSession(reader),
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
}

const put = (url: string, body: Buffer, mime: string) => fetch(url, { method: "PUT", headers: { "content-type": mime }, body: new Uint8Array(body) });
const bytes = (text: string) => new TextEncoder().encode(text);
const statusOf = async (owner: Client, id: string) => (await owner.query<{ status: string }>("select status::text from public.payouts where id = $1", [id])).rows[0]!.status;

describe("de empezar a bajar, por el servicio", () => {
  it("el PDF sube a la cubeta, el XML se lee y se cifra, la liquidación pasa a revisión, y los dos bajan", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const pay = await payout(owner, id, 204301, ana.id);
      await receiver(owner, RECEIVER);
      const service = serviceOn(owner);
      const begun = await service.beginInvoice(ana.jar, pay, "awaiting_invoice");
      if (begun.kind !== "begun") throw new Error(`no empezó: ${begun.kind}`);
      const path = `${id}/${pay}/${begun.invoice}.pdf`;
      uploaded.push(path);
      expect((await put(begun.uploadUrl, PDF, "application/pdf")).ok).toBe(true);
      const xml = xmlOf("6F9619FF-8B86-D011-B42D-000000004301", "goma 800101 ab1");
      expect(await service.submitInvoice(ana.jar, begun.invoice, bytes(xml))).toEqual({ kind: "submitted" });
      expect(await statusOf(owner, pay)).toBe("invoice_in_review");
      // Lo guardado está cifrado: el RFC no aparece en la base.
      const stored = (await owner.query<{ xml: Buffer }>("select xml_enc as xml from private.teacher_invoices where id = $1", [begun.invoice])).rows[0]!.xml;
      expect(stored.includes(Buffer.from("ANA GÓMEZ"))).toBe(false);

      const pdf = await service.invoiceFile(ana.jar, begun.invoice, "pdf");
      if (pdf.kind !== "url") throw new Error(`no bajó: ${pdf.kind}`);
      const got = await fetch(pdf.url);
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer()).equals(PDF)).toBe(true);
      expect(await service.invoiceFile(ana.jar, begun.invoice, "xml")).toEqual({ kind: "xml", text: xml });
    });
  });

  it("la cubeta no acepta lo que no es PDF, y sin PDF no se sube", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const pay = await payout(owner, id, 204302, ana.id);
      await receiver(owner, RECEIVER);
      const service = serviceOn(owner);
      const begun = await service.beginInvoice(ana.jar, pay, "awaiting_invoice");
      if (begun.kind !== "begun") throw new Error(`no empezó: ${begun.kind}`);
      uploaded.push(`${id}/${pay}/${begun.invoice}.pdf`);
      expect((await put(begun.uploadUrl, Buffer.from("hola"), "text/plain")).ok).toBe(false);
      expect(await service.submitInvoice(ana.jar, begun.invoice, bytes(xmlOf("6F9619FF-8B86-D011-B42D-000000004302")))).toEqual({ kind: "not_uploaded" });
    });
  });

  it("lo que no coincide se rechaza al subir, y su PDF se va de la cubeta", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const pay = await payout(owner, id, 204303, ana.id);
      await receiver(owner, RECEIVER);
      const service = serviceOn(owner);
      const begun = await service.beginInvoice(ana.jar, pay, "awaiting_invoice");
      if (begun.kind !== "begun") throw new Error(`no empezó: ${begun.kind}`);
      const path = `${id}/${pay}/${begun.invoice}.pdf`;
      uploaded.push(path);
      expect((await put(begun.uploadUrl, PDF, "application/pdf")).ok).toBe(true);
      const xml = xmlOf("6F9619FF-8B86-D011-B42D-000000004303").replaceAll('Importe="160.00"', 'Importe="160.01"').replace('TotalImpuestosTrasladados="160.00"', 'TotalImpuestosTrasladados="160.01"');
      expect(await service.submitInvoice(ana.jar, begun.invoice, bytes(xml))).toEqual({ kind: "amounts_mismatch", fields: ["vat_cents"] });
      expect(await storage.readStart(path, 4)).toBeNull();
      expect(await statusOf(owner, pay)).toBe("awaiting_invoice");
    });
  });

  it("otro RFC del emisor se rechaza", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const pay = await payout(owner, id, 204304, ana.id);
      await receiver(owner, RECEIVER);
      const service = serviceOn(owner);
      const begun = await service.beginInvoice(ana.jar, pay, "awaiting_invoice");
      if (begun.kind !== "begun") throw new Error(`no empezó: ${begun.kind}`);
      uploaded.push(`${id}/${pay}/${begun.invoice}.pdf`);
      expect((await put(begun.uploadUrl, PDF, "application/pdf")).ok).toBe(true);
      expect(await service.submitInvoice(ana.jar, begun.invoice, bytes(xmlOf("6F9619FF-8B86-D011-B42D-000000004304", "XYZA800101AB1")))).toEqual({ kind: "issuer_mismatch" });
    });
  });

  it("una maestra suspendida factura (FL-40 E3)", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana, "suspended");
      const pay = await payout(owner, id, 204305, ana.id);
      await receiver(owner, RECEIVER);
      const begun = await serviceOn(owner).beginInvoice(ana.jar, pay, "awaiting_invoice");
      expect(begun.kind).toBe("begun");
      if (begun.kind === "begun") uploaded.push(`${id}/${pay}/${begun.invoice}.pdf`);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Dos a la vez, con transacciones confirmadas.

describe("dos a la vez, de verdad", () => {
  const PERIODS = [204311, 204312];
  let owner: Client;
  let profile: string;
  let teacherId: string;
  const pays: string[] = [];

  beforeAll(async () => {
    owner = await connect();
    const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [PERIODS]);
    if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2043 en la base local: pnpm db:reset");
    const who = await person();
    profile = who.id;
    await owner.query("begin");
    teacherId = await teacher(owner, who);
    for (const period of PERIODS) pays.push(await payout(owner, teacherId, period, profile));
    await owner.query("commit");
  });

  afterAll(async () => {
    await owner.query("begin");
    try {
      await owner.query("set local session_replication_role = replica");
      await owner.query("delete from private.teacher_invoices where payout_id = any($1::uuid[])", [pays]);
      await owner.query("delete from public.payout_status_events where payout_id = any($1::uuid[])", [pays]);
      await owner.query("delete from public.payouts where id = any($1::uuid[])", [pays]);
      await owner.query("update public.payout_periods set close_run_id = null where period_id = any($1::int[])", [PERIODS]);
      await owner.query("delete from public.close_runs where period_id = any($1::int[])", [PERIODS]);
      await owner.query("delete from public.payout_periods where period_id = any($1::int[])", [PERIODS]);
      await owner.query("delete from private.teacher_tax_profiles where teacher_id = $1", [teacherId]);
      await owner.query("delete from public.teachers where id = $1", [teacherId]);
      await owner.query("update public.business_parameters set value = '\"PQ-20\"' where key = 'RFC_RECEPTOR'");
      await owner.query("set local session_replication_role = origin");
      await owner.query("commit");
    } catch (error) {
      await owner.query("rollback");
      throw error;
    }
    await owner.end();
  });

  /** Una conexión a nombre de la maestra, con su transacción abierta. */
  async function asTeacher(): Promise<Client> {
    const client = await connect();
    await client.query("begin");
    await client.query("select set_config('app.actor_id', $1, true)", [profile]);
    return client;
  }
  const call = async (client: Client, sql: string, args: unknown[]) => (await client.query<{ r: Record<string, unknown> }>(`select ${sql} as r`, args)).rows[0]!.r;

  it("dos subidas de la misma liquidación: la segunda espera a la primera y ve que ya hay una", async () => {
    await owner.query("begin");
    await receiver(owner, RECEIVER);
    await owner.query("commit");
    const a = await asTeacher();
    const b = await asTeacher();
    try {
      expect(await call(a, "private.invoice_begin($1, 'awaiting_invoice')", [pays[0]])).toMatchObject({ outcome: "begun" });
      const waiting = call(b, "private.invoice_begin($1, 'awaiting_invoice')", [pays[0]]);
      await waitBehind(owner, a, 1);
      await a.query("commit");
      expect(await waiting).toEqual({ outcome: "already_in_progress" });
      await b.query("commit");
    } finally {
      for (const client of [a, b]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
  });

  it("el mismo folio fiscal en dos liquidaciones a la vez: entra uno, y el otro sale duplicado", async () => {
    // Una subida por liquidación, con su PDF subido de verdad.
    const invoices: string[] = [];
    for (const pay of pays) {
      const starter = await asTeacher();
      await starter.query("delete from private.teacher_invoices where payout_id = $1 and status = 'uploading'", [pay]);
      const begun = (await call(starter, "private.invoice_begin($1, 'awaiting_invoice')", [pay])) as { invoice_id: string; path: string };
      await starter.query("commit");
      await starter.end();
      const url = await storage.signUpload(begun.path);
      if (url === null) throw new Error("no se firmó la subida");
      uploaded.push(begun.path);
      expect((await put(url, PDF, "application/pdf")).ok).toBe(true);
      invoices.push(begun.invoice_id);
    }
    const facts = {
      uuid: "6f9619ff-8b86-d011-b42d-000000004399", series: null, folio: null, issued_at: "2026-11-03T10:00:00", stamped_at: "2026-11-03T10:01:00",
      issuer_regime: "612", receiver_rfc: RECEIVER, receiver_regime: null, use: null, payment_method: null,
      subtotal_cents: 100000, vat_cents: 16000, income_tax_withheld_cents: 10000, vat_withheld_cents: 10667, total_cents: 95333,
    };
    const submit = (client: Client, invoice: string) =>
      call(client, "private.invoice_submit($1, $2, sha256('88'::bytea), $3::jsonb, true, 1, true)", [
        invoice, Buffer.from(`010001${"ab".repeat(60)}`, "hex"), JSON.stringify(facts),
      ]);
    const a = await asTeacher();
    const b = await asTeacher();
    try {
      expect(await submit(a, invoices[0]!)).toMatchObject({ outcome: "submitted" });
      const waiting = submit(b, invoices[1]!);
      await waitBehind(owner, a, 1);
      await a.query("commit");
      expect(await waiting).toEqual({ outcome: "duplicate_cfdi" });
      await b.query("commit");
    } finally {
      for (const client of [a, b]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    expect(await statusOf(owner, pays[0]!)).toBe("invoice_in_review");
    expect(await statusOf(owner, pays[1]!)).toBe("awaiting_invoice");
  });
});
