import "server-only";

import { messages, t } from "@/messages";
import type { MailCopy } from "@/services/mail/templates";

import { longDate } from "./dates";

// Los textos de los correos propios, para el servicio que los arma (T-604). Un servicio no importa el catálogo (TRD §4.2): se los da quien lo llama, y también cómo
// se escriben una cifra y una fecha.

const copy = messages.mail.clabeNotice;
const receipt = messages.mail.receipt;
const MONEY = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

export const mailCopy: MailCopy = {
  clabeNotice: {
    subject: copy.subject,
    intro: copy.intro,
    wait: (hours) => t(copy.wait, { hours: String(hours) }),
    yours: copy.yours,
    notYours: copy.notYours,
    recoverLabel: copy.recoverLabel,
    reviewLabel: copy.reviewLabel,
  },
  receipt: {
    subject: receipt.subject,
    paid: (cents, plan, at) => t(receipt.paid, { amount: MONEY.format(cents / 100), plan: receipt[plan], date: longDate(at) }),
    thanks: receipt.thanks,
    accountLabel: receipt.accountLabel,
  },
};
