import "server-only";

import { createMailpitSender } from "@/adapters/mailpit/send";
import { createResendSender } from "@/adapters/resend/send";
import { asSystem } from "@/adapters/supabase/db";
import { getEnv } from "@/config/env";
import type { MailSender } from "@/domain/mail/mail";
import { reportFailure } from "@/services/error-reporting/server";

import { createMailOutbox, pickSender, secretMatches } from "./outbox";
import { askMailClaim, askMailHealth, askMailRejected, askMailSent } from "./records";

// La salida de correo, ya armada: lo que importan las pantallas y la ruta del barrido. En local va siempre al buzón local, aunque haya una llave de Resend en `.env`: un desarrollo nunca le
// escribe a nadie de verdad. Fuera de local manda Resend, que en producción es obligatorio (`env.ts`); en una vista previa sin llave, nada sale y nada se gasta.

const LOCAL_MAILBOX = "http://127.0.0.1:54324";
const LOCAL_FROM = "Plataforma <avisos@plataforma.local>";

function sender(): MailSender | null {
  const env = getEnv();
  const who = pickSender(env);
  if (who === "mailbox") return createMailpitSender({ url: env.MAILPIT_URL ?? LOCAL_MAILBOX });
  return who === "resend" && env.RESEND_API_KEY !== undefined ? createResendSender({ apiKey: env.RESEND_API_KEY }) : null;
}

export const { dispatchMail, sweepMail } = createMailOutbox({
  store: {
    claim: (limit) => asSystem({ reason: "mail_claim" }, (tx) => askMailClaim(tx, limit)),
    sent: (id) => asSystem({ reason: "mail_sent" }, (tx) => askMailSent(tx, id)),
    rejected: (id, attempt) => asSystem({ reason: "mail_rejected" }, (tx) => askMailRejected(tx, id, attempt)),
    health: () => asSystem({ reason: "mail_health" }, askMailHealth),
  },
  sender,
  from: () => (getEnv().APP_ENV === "local" ? LOCAL_FROM : (getEnv().MAIL_FROM_NOTICES ?? LOCAL_FROM)),
  site: () => getEnv().NEXT_PUBLIC_SITE_URL,
  report: reportFailure,
});

/** Si lo que llegó es la llave del barrido programado. */
export const mailSweepAllowed = (token: string | null): boolean => secretMatches(getEnv().CRON_SECRET, token);
