import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { HOUR_SECONDS, decideMailSend, decideRegistration, windowStart } from "./rate-window";

// Los topes por ventana (TRD §9.9). Las ventanas son fijas y alineadas al reloj, que es lo
// que guarda private.rate_limit_counters: la hora en punto para los topes por hora. Las
// cuentas que entran aquí son las de ANTES del intento que se decide.

const at = (iso: string) => new Date(iso);

describe("windowStart", () => {
  it("la ventana de una hora empieza en la hora en punto, en UTC", () => {
    expect(windowStart(at("2026-10-10T14:37:21.500Z"), HOUR_SECONDS)).toEqual({
      ok: true,
      start: at("2026-10-10T14:00:00.000Z"),
    });
  });

  it("el primer instante de una ventana es su propio inicio", () => {
    expect(windowStart(at("2026-10-10T14:00:00.000Z"), HOUR_SECONDS)).toEqual({
      ok: true,
      start: at("2026-10-10T14:00:00.000Z"),
    });
  });

  it("una ventana de un minuto empieza en el minuto en punto", () => {
    expect(windowStart(at("2026-10-10T14:37:21.500Z"), 60)).toEqual({
      ok: true,
      start: at("2026-10-10T14:37:00.000Z"),
    });
  });

  it("un reloj inválido no da ventana", () => {
    expect(windowStart(new Date(Number.NaN), HOUR_SECONDS)).toEqual({ ok: false, reason: "invalid_clock" });
  });

  it.each([0, -60, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e13, Number.MAX_SAFE_INTEGER])(
    "un tamaño de %s segundos no da ventana",
    (size) => {
      expect(windowStart(at("2026-10-10T14:37:21Z"), size)).toEqual({ ok: false, reason: "invalid_window" });
    },
  );

  it("en el borde de lo que cabe en una fecha, no da ventana", () => {
    expect(windowStart(new Date(-8.64e15), 7)).toEqual({ ok: false, reason: "invalid_clock" });
  });

  it("antes de 1970 la ventana también empieza antes del instante, no después", () => {
    expect(windowStart(at("1969-12-31T23:30:00.000Z"), HOUR_SECONDS)).toEqual({
      ok: true,
      start: at("1969-12-31T23:00:00.000Z"),
    });
  });

  const clock = fc.date({ min: at("2020-01-01T00:00:00Z"), max: at("2100-01-01T00:00:00Z"), noInvalidDate: true });
  const size = fc.integer({ min: 1, max: 7 * 24 * 3600 });

  it("la ventana contiene al instante, mide lo que se pidió y es estable", () => {
    fc.assert(
      fc.property(clock, size, (now, seconds) => {
        const result = windowStart(now, seconds);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const start = result.start.getTime();
        expect(start).toBeLessThanOrEqual(now.getTime());
        expect(now.getTime() - start).toBeLessThan(seconds * 1000);
        expect(start % (seconds * 1000)).toBe(0);
        // Cualquier instante de la misma ventana da el mismo inicio.
        expect(windowStart(result.start, seconds)).toEqual(result);
      }),
    );
  });
});

describe("decideRegistration", () => {
  const params = { hourlyCap: 20 };

  it("deja pasar mientras no se haya llegado al tope de registros de esa red", () => {
    expect(decideRegistration({ ipHitsThisHour: 0 }, params)).toEqual({ proceed: true });
    expect(decideRegistration({ ipHitsThisHour: 19 }, params)).toEqual({ proceed: true });
  });

  it("con el tope ya contado, el siguiente no pasa", () => {
    expect(decideRegistration({ ipHitsThisHour: 20 }, params)).toEqual({ proceed: false, reason: "ip_hourly_cap" });
    expect(decideRegistration({ ipHitsThisHour: 500 }, params)).toEqual({ proceed: false, reason: "ip_hourly_cap" });
  });

  it.each([
    ["una cuenta negativa", { ipHitsThisHour: -1 }, { hourlyCap: 20 }],
    ["una cuenta que no es entera", { ipHitsThisHour: 1.5 }, { hourlyCap: 20 }],
    ["una cuenta que no es un número", { ipHitsThisHour: Number.NaN }, { hourlyCap: 20 }],
    ["un tope de cero", { ipHitsThisHour: 0 }, { hourlyCap: 0 }],
    ["un tope que no es un número", { ipHitsThisHour: 0 }, { hourlyCap: Number.NaN }],
  ])("con %s no deja pasar", (_name, facts, badParams) => {
    expect(decideRegistration(facts, badParams)).toEqual({ proceed: false, reason: "invalid_input" });
  });
});

describe("decideMailSend", () => {
  const params = { hourlyCap: 5, resendWaitSeconds: 60 };
  const now = at("2026-10-11T10:00:30.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("manda si el buzón no llegó a su tope y nunca se le mandó nada", () => {
    expect(decideMailSend({ mailboxHitsThisHour: 0, lastSentAt: null }, now, params)).toEqual({ send: true });
    expect(decideMailSend({ mailboxHitsThisHour: 4, lastSentAt: null }, now, params)).toEqual({ send: true });
  });

  // La espera se mide desde el último correo, no por minuto de reloj: a las 10:00:59 y a
  // las 10:01:00 son dos minutos distintos y un segundo de diferencia.
  it.each([
    ["en el mismo instante", 0, false],
    ["un segundo después, aunque ya sea otro minuto del reloj", 1_000, false],
    ["un milisegundo antes de cumplirse", 59_999, false],
    ["justo al cumplirse", 60_000, true],
    ["mucho después", 3_600_000, true],
  ])("con el último correo %s", (_name, elapsedMs, send) => {
    const decision = decideMailSend({ mailboxHitsThisHour: 1, lastSentAt: ago(elapsedMs) }, now, params);
    expect(decision).toEqual(send ? { send: true } : { send: false, reason: "resend_wait" });
  });

  it("no manda si el buzón ya llegó a su tope de la hora, aunque la espera haya pasado", () => {
    expect(decideMailSend({ mailboxHitsThisHour: 5, lastSentAt: ago(3_000_000) }, now, params)).toEqual({
      send: false,
      reason: "mailbox_hourly_cap",
    });
    expect(decideMailSend({ mailboxHitsThisHour: 5, lastSentAt: null }, now, params)).toEqual({
      send: false,
      reason: "mailbox_hourly_cap",
    });
  });

  it("si coinciden las dos cosas, el motivo es el tope, que es el que dura más", () => {
    expect(decideMailSend({ mailboxHitsThisHour: 5, lastSentAt: ago(1_000) }, now, params)).toEqual({
      send: false,
      reason: "mailbox_hourly_cap",
    });
  });

  it("un último correo con hora del futuro no manda: el reloj retrocedió y no se adivina", () => {
    expect(decideMailSend({ mailboxHitsThisHour: 1, lastSentAt: ago(-1) }, now, params)).toEqual({
      send: false,
      reason: "resend_wait",
    });
    // Tampoco con la espera en cero.
    expect(
      decideMailSend({ mailboxHitsThisHour: 1, lastSentAt: ago(-1) }, now, { hourlyCap: 5, resendWaitSeconds: 0 }),
    ).toEqual({ send: false, reason: "resend_wait" });
  });

  it("con la espera en cero solo frena el tope", () => {
    const noWait = { hourlyCap: 5, resendWaitSeconds: 0 };
    expect(decideMailSend({ mailboxHitsThisHour: 1, lastSentAt: ago(0) }, now, noWait)).toEqual({ send: true });
    expect(decideMailSend({ mailboxHitsThisHour: 5, lastSentAt: ago(0) }, now, noWait)).toEqual({
      send: false,
      reason: "mailbox_hourly_cap",
    });
  });

  const good = { mailboxHitsThisHour: 0, lastSentAt: null };
  it.each([
    ["una cuenta de la hora negativa", { mailboxHitsThisHour: -1, lastSentAt: null }, now, params],
    ["una cuenta de la hora que no es entera", { mailboxHitsThisHour: 0.5, lastSentAt: null }, now, params],
    ["un último correo sin fecha válida", { mailboxHitsThisHour: 0, lastSentAt: new Date(Number.NaN) }, now, params],
    ["un reloj inválido", good, new Date(Number.NaN), params],
    ["un tope de cero", good, now, { hourlyCap: 0, resendWaitSeconds: 60 }],
    ["una espera negativa", good, now, { hourlyCap: 5, resendWaitSeconds: -1 }],
    ["una espera que no es entera", good, now, { hourlyCap: 5, resendWaitSeconds: 0.5 }],
    ["una espera que no cabe en milisegundos", good, now, { hourlyCap: 5, resendWaitSeconds: Number.MAX_SAFE_INTEGER }],
  ])("con %s no manda", (_name, facts, clock, badParams) => {
    expect(decideMailSend(facts, clock, badParams)).toEqual({ send: false, reason: "invalid_input" });
  });

  it("nunca manda más de lo que dice el tope dentro de una hora", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 200 }), (cap, attempts) => {
        let sent = 0;
        for (let i = 0; i < attempts; i += 1) {
          // Cada intento llega ya pasada la espera: lo único que frena es el tope.
          const facts = { mailboxHitsThisHour: sent, lastSentAt: sent === 0 ? null : ago(3_600_000) };
          if (decideMailSend(facts, now, { hourlyCap: cap, resendWaitSeconds: 60 }).send) sent += 1;
        }
        expect(sent).toBe(Math.min(cap, attempts));
      }),
    );
  });

  it("entre dos correos seguidos siempre pasa la espera completa", () => {
    const wait = fc.integer({ min: 0, max: 3_600 });
    const gaps = fc.array(fc.integer({ min: 0, max: 200_000 }), { minLength: 1, maxLength: 40 });
    fc.assert(
      fc.property(wait, gaps, (seconds, steps) => {
        const sentAt: number[] = [];
        let clock = now.getTime();
        for (const step of steps) {
          clock += step;
          const last = sentAt.at(-1);
          const decision = decideMailSend(
            { mailboxHitsThisHour: 0, lastSentAt: last === undefined ? null : new Date(last) },
            new Date(clock),
            { hourlyCap: 1_000, resendWaitSeconds: seconds },
          );
          if (decision.send) sentAt.push(clock);
        }
        for (let i = 1; i < sentAt.length; i += 1) {
          expect((sentAt[i] as number) - (sentAt[i - 1] as number)).toBeGreaterThanOrEqual(seconds * 1000);
        }
        // Y el primero siempre sale: sin correo anterior no hay espera.
        expect(sentAt[0]).toBe(now.getTime() + (steps[0] as number));
      }),
    );
  });
});
