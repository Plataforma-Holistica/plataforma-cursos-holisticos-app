import { createHash, timingSafeEqual } from "node:crypto";

import type { MailSender } from "@/domain/mail/mail";

import { renderMail, type MailCopy } from "./templates";

// La salida de correo (T-604). La base dice qué toca y aparta cada fila; aquí se arma, se manda y se anota, con nada tomado mientras se habla con el proveedor. Es «al menos una vez»:
// si salió y no se pudo anotar, vence y sale otra vez, y dentro de 24 horas la llave de idempotencia lo detiene. Nada de esto lanza: el correo nunca detiene lo que lo pidió. Un reporte lleva
// un código y nunca una dirección.

export interface ClaimedMail {
  id: string;
  key: string;
  template: string;
  recipient: string;
  params: unknown;
  attempt: number;
}

export interface MailStore {
  claim(limit: number): Promise<ClaimedMail[]>;
  sent(id: string): Promise<void>;
  rejected(id: string, attempt: number): Promise<void>;
  health(): Promise<{ failed: number; overdue: number }>;
}

export interface MailOutboxDeps {
  store: MailStore;
  /** Nulo si aquí no hay quien mande (una vista previa sin llave): nada se reclama. */
  sender: () => MailSender | null;
  from: () => string;
  site: () => string;
  report: (code: MailFailure) => Promise<void>;
}

export type MailFailure = "mail_unrenderable" | "mail_rejected" | "mail_retry" | "mail_unavailable" | "mail_failed" | "mail_overdue";

const BATCH = 20;

export function createMailOutbox(deps: MailOutboxDeps) {
  const { store, report } = deps;

  async function sendOne(send: MailSender, row: ClaimedMail, copy: MailCopy): Promise<void> {
    const mail = renderMail(row.template, row.params, deps.site(), copy);
    if (mail === null) {
      await report("mail_unrenderable");
      await store.rejected(row.id, row.attempt);
      return;
    }
    const result = await send({ ...mail, key: row.key, from: deps.from(), to: row.recipient });
    if (result === "sent") {
      await store.sent(row.id);
    } else if (result === "rejected") {
      await report("mail_rejected");
      await store.rejected(row.id, row.attempt);
    } else {
      await report("mail_retry");
    }
  }

  /** Manda lo que toca. Corre detrás de la respuesta de quien lo pidió, y en el barrido. */
  async function dispatchMail(copy: MailCopy): Promise<void> {
    const send = deps.sender();
    if (send === null) return;
    let rows: ClaimedMail[];
    try {
      rows = await store.claim(BATCH);
    } catch {
      await report("mail_unavailable");
      return;
    }
    for (const row of rows) {
      try {
        await sendOne(send, row, copy);
      } catch {
        await report("mail_unavailable");
      }
    }
  }

  /** El respaldo programado: manda lo que se haya quedado, y dice lo que lleva tiempo sin salir. Falso si no pudo preguntar. */
  async function sweepMail(copy: MailCopy): Promise<boolean> {
    await dispatchMail(copy);
    try {
      const health = await store.health();
      if (health.failed > 0) await report("mail_failed");
      if (health.overdue > 0) await report("mail_overdue");
      return true;
    } catch {
      await report("mail_unavailable");
      return false;
    }
  }

  return { dispatchMail, sweepMail };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Si lo que llegó es la llave del barrido. Sin llave configurada nadie pasa. Se comparan huellas, en tiempo constante y del mismo largo. */
export function secretMatches(secret: string | undefined, token: string | null): boolean {
  if (secret === undefined || secret === "" || token === null) return false;
  return timingSafeEqual(digest(secret), digest(token));
}
