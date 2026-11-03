import "server-only";

import { messages, t } from "@/messages";
import type { MailCopy } from "@/services/mail/templates";

// Los textos de los correos propios, para el servicio que los arma (T-604). Un servicio no importa el catálogo (TRD §4.2): se los da quien lo llama.

const copy = messages.mail.clabeNotice;

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
};
