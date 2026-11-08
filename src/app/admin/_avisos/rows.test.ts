import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { admin } from "@/messages/es/admin";
import type { BillingQueueData, BillingQueueEvent } from "@/services/billing/billing";

import { BILLING_ERROR_CODES, billingView, errorText, stripeEventHref } from "./rows";

const text = admin.billingEvents;

const EVENT: BillingQueueEvent = {
  id: "e0000000-0000-4000-8000-000000000001",
  revision: 4,
  providerEventId: "evt_1",
  eventType: "invoice.paid",
  livemode: false,
  objectId: "in_1",
  occurredAt: "2026-11-07T18:00:00+00:00",
  receivedAt: "2026-11-07T18:00:05+00:00",
  status: "failed",
  attempts: 2,
  nextAttemptAt: "2026-11-07T18:05:00+00:00",
  lastError: "zero_invoice",
  isSelf: false,
};
const queue = (events: BillingQueueEvent[], total = events.length, freshCode = true): BillingQueueData => ({ freshCode, total, events });

describe("la vista de PA-84", () => {
  it("cada fila dice la fecha en la zona del producto, el tipo y el código en palabras, y los ids", () => {
    const [row] = billingView(queue([EVENT])).rows;
    expect(row).toMatchObject({
      date: "7 de noviembre de 2026",
      type: text.types.invoicePaid,
      status: text.status.failed,
      tone: "bad",
      attempts: "2 intentos",
      error: text.errors.zeroInvoice,
      eventId: "evt_1",
      objectId: "in_1",
      offer: "actions",
      revision: 4,
      testMode: true,
    });
    expect(row?.received).toContain("7 de noviembre de 2026");
  });

  it("todo código que la base, el servidor o la lectura de Stripe dejan tiene su texto", () => {
    for (const code of BILLING_ERROR_CODES) expect(errorText(code), code).not.toContain(code);
  });

  it("la lista tiene todo código que dejan las fuentes: uno nuevo hace fallar esta prueba", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const read = (file: string) => readFileSync(join(root, file), "utf8");
    const found = new Set<string>();
    for (const file of ["src/services/billing/inbox.ts", "src/services/billing/stripe-read.ts"]) {
      for (const match of read(file).matchAll(/code: "([a-z0-9_]+)"/g)) found.add(match[1]!);
      for (const match of read(file).matchAll(/settle\(event, \{ kind: "failed", code: "([a-z0-9_]+)" \}\)/g)) found.add(match[1]!);
    }
    const migrations = readdirSync(join(root, "supabase", "migrations")).filter((file) => /_t303_/.test(file));
    for (const file of migrations) {
      const sql = read(join("supabase", "migrations", file));
      // Sin `'charge_' || …`, que se arma al vuelo: sus códigos salen de `record_charge`, abajo.
      for (const match of sql.matchAll(/message = '([a-z0-9_]+)'(?! \|\|)/g)) found.add(match[1]!);
      for (const match of sql.matchAll(/last_error = '([a-z0-9_]+)'/g)) found.add(match[1]!);
      for (const match of sql.matchAll(/v_code := '([a-z0-9_]+)'/g)) found.add(match[1]!);
    }
    // `charge_<respuesta>`: lo que `record_charge` contesta y no es un cobro.
    const bandeja = read("supabase/migrations/20261107033615_t303_bandeja.sql");
    const recordCharge = bandeja.slice(bandeja.indexOf("create function private.record_charge("), bandeja.indexOf("create function private.billing_state("));
    expect(recordCharge.length).toBeGreaterThan(100);
    for (const match of recordCharge.matchAll(/'outcome', '([a-z_]+)'/g)) {
      if (match[1] !== "recorded" && match[1] !== "already_recorded") found.add(`charge_${match[1]}`);
    }
    // Lo que el servidor manda a la fila sin ser un código de falla.
    for (const code of ["stripe_signature_invalid"]) found.delete(code);
    expect(found.size).toBeGreaterThan(20);
    expect([...found].filter((code) => !(BILLING_ERROR_CODES as readonly string[]).includes(code)).sort()).toEqual([]);
  });

  it("un código que no conoce se dice tal cual, sin perderse", () => {
    expect(errorText("algo_nuevo")).toBe("Código sin traducir: algo_nuevo.");
  });

  it("lo que espera a T-307, lo que va en camino y el aviso del pago propio no ofrecen acciones", () => {
    const view = billingView(
      queue([
        { ...EVENT, id: "e1", eventType: "charge.refunded", status: "deferred", lastError: "refund_waits_t307" },
        { ...EVENT, id: "e2", status: "pending", lastError: null },
        { ...EVENT, id: "e3", status: "processing", lastError: null },
        { ...EVENT, id: "e4", isSelf: true },
      ]),
    );
    expect(view.rows.map((row) => row.offer)).toEqual(["waits", "on_its_way", "on_its_way", "yours"]);
    expect(view.rows.map((row) => row.error)).toEqual([text.errors.refundWaitsT307, null, null, text.errors.zeroInvoice]);
  });

  it("las disputas y los tipos desconocidos también se dicen", () => {
    const view = billingView(queue([{ ...EVENT, eventType: "charge.dispute.created" }, { ...EVENT, id: "e2", eventType: "customer.created" }]));
    expect(view.rows.map((row) => row.type)).toEqual([text.types.dispute, "Otro tipo (customer.created)"]);
  });

  it("el enlace va al panel del modo del aviso, con el id escapado", () => {
    expect(stripeEventHref("evt_1", false)).toBe("https://dashboard.stripe.com/test/events/evt_1");
    expect(stripeEventHref("evt_1", true)).toBe("https://dashboard.stripe.com/events/evt_1");
    expect(stripeEventHref("evt_1/../x?y#z", true)).toBe("https://dashboard.stripe.com/events/evt_1%2F..%2Fx%3Fy%23z");
    expect(billingView(queue([{ ...EVENT, livemode: true }])).rows[0]?.testMode).toBe(false);
  });

  it("si su código no es reciente, no se puede cambiar; y dice cuántos no caben", () => {
    expect(billingView(queue([EVENT], 1, false)).canChange).toBe(false);
    expect(billingView(queue([EVENT], 1)).more).toBeNull();
    expect(billingView(queue([EVENT], 3)).more).toBe("Hay 2 avisos más que no caben aquí.");
  });
});
