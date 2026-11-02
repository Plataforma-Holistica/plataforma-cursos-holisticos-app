import { describe, expect, it, vi } from "vitest";

import type { SendResult } from "@/domain/mail/mail";

import { createMailOutbox, secretMatches, type ClaimedMail, type MailStore } from "./outbox";
import type { MailCopy } from "./templates";

const COPY: MailCopy = {
  clabeNotice: { subject: "Asunto", intro: "Intro", wait: (hours) => `${hours} horas`, yours: "Tuya", notYours: "No tuya", recoverLabel: "Cambiar", reviewLabel: "Ver" },
};
const ROW: ClaimedMail = { id: "1", key: "CO-27:a:1", template: "CO-27", recipient: "mara@prueba.test", params: { hours: 72 }, attempt: 3 };

function setup(options: { rows?: ClaimedMail[]; result?: SendResult; store?: Partial<MailStore>; sender?: null } = {}) {
  const store: MailStore = {
    claim: vi.fn(() => Promise.resolve(options.rows ?? [ROW])),
    sent: vi.fn(() => Promise.resolve()),
    rejected: vi.fn(() => Promise.resolve()),
    health: vi.fn(() => Promise.resolve({ failed: 0, overdue: 0 })),
    ...options.store,
  };
  const send = vi.fn(() => Promise.resolve(options.result ?? "sent"));
  const report = vi.fn(() => Promise.resolve());
  const outbox = createMailOutbox({
    store,
    sender: options.sender === null ? () => null : () => send,
    from: () => "Avisos <avisos@ejemplo.test>",
    site: () => "https://plataforma.ejemplo.test",
    report,
  });
  return { store, send, report, outbox };
}

describe("mandar lo que toca", () => {
  it("manda lo reclamado con su llave, y lo anota", async () => {
    const { outbox, send, store } = setup();
    await outbox.dispatchMail(COPY);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([expect.objectContaining({ key: ROW.key, to: ROW.recipient, from: "Avisos <avisos@ejemplo.test>" })]);
    expect(store.sent).toHaveBeenCalledWith(ROW.id);
    expect(store.rejected).not.toHaveBeenCalled();
  });

  it("lo que no se supo no se anota: vence y se vuelve a tomar", async () => {
    const { outbox, store, report } = setup({ result: "retry" });
    await outbox.dispatchMail(COPY);
    expect(store.sent).not.toHaveBeenCalled();
    expect(store.rejected).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("mail_retry");
  });

  it("un rechazo se anota con su intento, y se reporta", async () => {
    const { outbox, store, report } = setup({ result: "rejected" });
    await outbox.dispatchMail(COPY);
    expect(store.rejected).toHaveBeenCalledWith(ROW.id, 3);
    expect(report).toHaveBeenCalledWith("mail_rejected");
  });

  it("una fila sin forma se rechaza sin llamar a nadie", async () => {
    const { outbox, store, send, report } = setup({ rows: [{ ...ROW, params: { hours: "x" } }] });
    await outbox.dispatchMail(COPY);
    expect(send).not.toHaveBeenCalled();
    expect(store.rejected).toHaveBeenCalledWith(ROW.id, 3);
    expect(report).toHaveBeenCalledWith("mail_unrenderable");
  });

  it("sin quien mande no reclama: un intento gastado no le serviría a nadie", async () => {
    const { outbox, store } = setup({ sender: null });
    await outbox.dispatchMail(COPY);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("si la base no contesta, lo reporta y no lanza: nada se detiene por el correo", async () => {
    const { outbox, report, send } = setup({ store: { claim: () => Promise.reject(new Error("corte")) } });
    await expect(outbox.dispatchMail(COPY)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("mail_unavailable");
  });

  it("si salió y no se pudo anotar, lo reporta y sigue con los demás", async () => {
    const second = { ...ROW, id: "2" };
    const sent = vi.fn<MailStore["sent"]>().mockRejectedValueOnce(new Error("corte")).mockResolvedValue(undefined);
    const { outbox, report } = setup({ rows: [ROW, second], store: { sent } });
    await outbox.dispatchMail(COPY);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith("mail_unavailable");
  });

  it("no lleva la dirección a un reporte", async () => {
    const { outbox, report } = setup({ result: "rejected" });
    await outbox.dispatchMail(COPY);
    expect(JSON.stringify(report.mock.calls)).not.toContain("mara@");
  });
});

describe("el barrido", () => {
  it("manda, y dice lo que lleva tiempo sin salir", async () => {
    const { outbox, send, report } = setup({ store: { health: () => Promise.resolve({ failed: 2, overdue: 1 }) } });
    expect(await outbox.sweepMail(COPY)).toBe(true);
    expect(send).toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("mail_failed");
    expect(report).toHaveBeenCalledWith("mail_overdue");
  });

  it("sano, no reporta nada", async () => {
    const { outbox, report } = setup();
    expect(await outbox.sweepMail(COPY)).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it("sin base contesta que no pudo", async () => {
    const { outbox } = setup({ store: { health: () => Promise.reject(new Error("corte")) } });
    expect(await outbox.sweepMail(COPY)).toBe(false);
  });
});

describe("la llave del barrido", () => {
  const SECRET = "s".repeat(40);
  it.each([
    [SECRET, SECRET, true],
    [SECRET, `${SECRET}x`, false],
    [SECRET, "corta", false],
    [SECRET, "", false],
    [SECRET, null, false],
    [undefined, SECRET, false],
    [undefined, null, false],
    ["", "", false],
  ])("%j contra %j: %j", (secret, token, expected) => {
    expect(secretMatches(secret, token)).toBe(expected);
  });
});
