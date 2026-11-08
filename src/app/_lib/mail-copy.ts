import "server-only";

import { eventTypeText } from "@/app/admin/_avisos/rows";
import { messages, plural, t } from "@/messages";
import type { MailCopy } from "@/services/mail/templates";

import { clockTime, longDate, PRODUCT_TIME_ZONE } from "./dates";

// Los textos de los correos propios, para el servicio que los arma (T-604). Un servicio no importa el catálogo (TRD §4.2): se los da quien lo llama, y también cómo
// se escriben una cifra y una fecha.

const copy = messages.mail.clabeNotice;
const receipt = messages.mail.receipt;
const billingAlert = messages.mail.billingAlert;
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
  // El tipo en las mismas palabras que PA-84, y la hora en la zona del producto.
  billingAlert: {
    subject: billingAlert.subject,
    failed: (count, type, at) =>
      t(plural(count, billingAlert.failed), { count: String(count), type: eventTypeText(type), date: longDate(at), time: clockTime(at, PRODUCT_TIME_ZONE) }),
    action: billingAlert.action,
    linkLabel: billingAlert.linkLabel,
  },
};
