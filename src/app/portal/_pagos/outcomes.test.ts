import { describe, expect, it } from "vitest";

import { consentsPath, ROUTES, signInPath } from "@/services/account/navigation";
import type { TeacherPayoutStatus } from "@/services/teachers/payout-report-data";

import { csvButton, csvHref, csvOutcome, nextStep, overdueText, PAYOUT_STATUS, readCsvForm, type NextFacts } from "./outcomes";
import { periodTitle, points } from "./rows";

// PA-46 y PA-47 (T-604, cuarta solicitud): cada estado con su etiqueta y su «Qué sigue», y qué hace la acción del CSV con cada respuesta.

const NONE: Omit<NextFacts, "status"> = {
  amount: null,
  dueOn: null,
  submittedOn: null,
  rejectionReason: null,
  paidOn: null,
  reference: null,
  carried: null,
  receiverReady: true,
};
const next = (status: TeacherPayoutStatus, facts: Partial<NextFacts> = {}) => nextStep({ ...NONE, status, ...facts });
const BACK = "/portal/pagos/2031-02";

const form = (value: string) => {
  const data = new FormData();
  data.append("do", value);
  return data;
};

describe("los estados que ve el maestro", () => {
  it.each<[TeacherPayoutStatus, string, string]>([
    ["empty", "En cero", "Este periodo quedó en cero: no hubo reparto para ti. No hace falta factura."],
    ["calculated", "Calculada", "Estamos confirmando bonos y ajustes. Te avisamos cuando puedas facturar."],
    ["awaiting_invoice", "En espera de factura", "Ya puedes facturar."],
    ["invoice_in_review", "Factura en revisión", "Recibimos tu factura. La estamos revisando."],
    ["invoice_rejected", "Factura rechazada", "Tu factura no se pudo aceptar. Sube otra."],
    ["ready_to_pay", "Lista para pago", "Tu factura fue aceptada. Tu pago va en camino."],
    ["paid", "Pagada", "Pagado."],
    ["carried_forward", "Acumulada", "Se suma a tu siguiente pago. No hace falta factura."],
    ["payment_returned", "Pago devuelto", "Tu pago fue devuelto por el banco. Lo volvemos a enviar."],
    ["in_review", "En revisión", "Estamos revisando esta liquidación. Te avisamos cuando avance."],
    ["tax_data_missing", "Faltan tus datos fiscales", "Para pagarte necesitamos tus datos fiscales y bancarios."],
    ["tax_data_review", "Revisando tus datos", "Ya capturaste tus datos fiscales. Los estamos revisando para liberar tu pago."],
  ])("%s: «%s», y sin datos «%s»", (status, label, said) => {
    expect(PAYOUT_STATUS[status].label).toBe(label);
    expect(next(status).text).toBe(said);
  });

  it("solo sin datos fiscales se ofrece capturarlos", () => {
    const statuses = Object.keys(PAYOUT_STATUS) as TeacherPayoutStatus[];
    expect(statuses.filter((status) => next(status).taxDataLink)).toEqual(["tax_data_missing"]);
  });

  it("«en revisión» no dice ningún motivo", () => {
    expect(next("in_review", { rejectionReason: "Fraude" }).text).not.toContain("Fraude");
  });

  it("con sus datos, cada estado los dice", () => {
    expect(next("awaiting_invoice", { amount: "$1,000.00", dueOn: "5 de marzo de 2031" }).text).toBe("Ya puedes facturar por $1,000.00. Tu fecha límite es el 5 de marzo de 2031.");
    expect(next("awaiting_invoice", { amount: "$1,000.00" }).text).toBe("Ya puedes facturar por $1,000.00.");
    expect(next("invoice_in_review", { submittedOn: "2 de marzo de 2031" }).text).toBe("Recibimos tu factura el 2 de marzo de 2031. La estamos revisando.");
    expect(next("invoice_rejected", { rejectionReason: "El RFC no coincide" }).text).toBe("Tu factura no se pudo aceptar. Motivo: El RFC no coincide. Sube otra.");
    expect(next("paid", { paidOn: "10 de marzo de 2031", reference: "ABC123" }).text).toBe("Pagado el 10 de marzo de 2031. Referencia: ABC123.");
    expect(next("paid", { paidOn: "10 de marzo de 2031" }).text).toBe("Pagado.");
  });

  it("la acumulada dice lo que pasa al siguiente, también en contra", () => {
    expect(next("carried_forward", { carried: { amount: "$120.00", against: false } }).text).toBe(
      "Este periodo no llegó al pago mínimo. Tu saldo de $120.00 se suma a tu siguiente pago. No hace falta factura.",
    );
    expect(next("carried_forward", { carried: { amount: "$45.00", against: true } }).text).toBe(
      "Este periodo quedó en contra por $45.00. Se descuenta de tu siguiente pago. No hace falta factura.",
    );
  });

  it("la línea de pasos: una rechazada espera factura, un pago devuelto vuelve a lista para pago, y lo retenido o acumulado no marca paso", () => {
    expect(PAYOUT_STATUS.invoice_rejected.step).toBe("awaiting_invoice");
    expect(PAYOUT_STATUS.payment_returned.step).toBe("ready_to_pay");
    for (const status of ["empty", "carried_forward", "in_review", "tax_data_missing", "tax_data_review"] as const) expect(PAYOUT_STATUS[status].step).toBeNull();
  });

  it("vencida: se puede facturar igual", () => {
    expect(overdueText("5 de marzo de 2031")).toBe("La fecha límite para facturar este periodo venció el 5 de marzo de 2031. Todavía puedes facturar: la factura tardía también se paga.");
    expect(overdueText(null)).toContain("ya venció");
  });
});

describe("puntos y periodo", () => {
  it("medios puntos como puntos, con «.5» si toca", () => {
    expect([0, 1, 2, 3, 8, 117].map(points)).toEqual(["0", "0.5", "1", "1.5", "4", "58.5"]);
  });

  it("el periodo como mes, con mayúscula", () => {
    expect(periodTitle("2031-02")).toBe("Febrero de 2031");
  });
});

describe("el CSV", () => {
  it("el botón lleva el periodo, y solo un periodo con forma cuenta", () => {
    expect(readCsvForm(form(csvButton("2031-02")))).toEqual({ period: "2031-02" });
    for (const value of ["csv:2031-13", "csv:2031-2", "csv:203102", "otro:2031-02", "csv:2031-02 ", `csv:${"9".repeat(40)}`]) expect(readCsvForm(form(value))).toBeNull();
    expect(readCsvForm(new FormData())).toBeNull();
  });

  it("el archivo vuelve como dirección de datos con su contenido exacto", () => {
    const content = "﻿\"Alumno\",\"Puntos\",\"Pesos\"\r\n\"Ceiba 42\",2,\r\n";
    expect(csvOutcome({ kind: "csv", fileName: "reporte-2031-02.csv", text: content }, BACK)).toEqual({ kind: "file", fileName: "reporte-2031-02.csv", href: csvHref(content) });
    expect(decodeURIComponent(csvHref(content).slice("data:text/csv;charset=utf-8,".length))).toBe(content);
  });

  it("lo que no se pudo se dice; quien ya no es maestro vuelve a la pantalla", () => {
    expect(csvOutcome({ kind: "not_found" }, BACK)).toEqual({ kind: "failed", reason: "not_found" });
    expect(csvOutcome({ kind: "unavailable" }, BACK)).toEqual({ kind: "failed", reason: "unavailable" });
    expect(csvOutcome({ kind: "not_teacher" }, BACK)).toEqual({ kind: "leave", to: BACK, notice: null, closeSession: false });
  });

  it("la sesión rechazada, como en las otras acciones del portal", () => {
    expect(csvOutcome({ kind: "session", check: { kind: "anonymous" } }, BACK)).toEqual({ kind: "leave", to: signInPath(BACK), notice: null, closeSession: false });
    expect(signInPath(BACK)).toContain(encodeURIComponent(BACK));
    // Una cuenta a medias trae sus claims y lo que le falta: aquí solo importa su tipo.
    expect(csvOutcome({ kind: "session", check: { kind: "incomplete" } } as never, BACK)).toEqual({ kind: "leave", to: consentsPath(BACK), notice: null, closeSession: false });
    expect(csvOutcome({ kind: "session", check: { kind: "suspended" } }, BACK)).toEqual({ kind: "leave", to: BACK, notice: null, closeSession: false });
    expect(csvOutcome({ kind: "session", check: { kind: "unavailable" } }, BACK)).toEqual({ kind: "failed", reason: "unavailable" });
    expect(csvOutcome({ kind: "session", check: { kind: "must_sign_out", then: "recover" } }, BACK)).toEqual({
      kind: "leave",
      to: ROUTES.recover,
      notice: "choose_password",
      closeSession: true,
    });
    expect(csvOutcome({ kind: "session", check: { kind: "must_sign_out", then: "sign_in" } }, BACK)).toEqual({ kind: "leave", to: ROUTES.signIn, notice: null, closeSession: true });
  });
});
