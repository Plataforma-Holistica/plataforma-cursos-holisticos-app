import { z } from "zod";

import { ROUTES } from "@/services/account/navigation";

// Lo que dice cada correo propio (T-604). La fila guarda la plantilla y sus datos, nunca el cuerpo. Texto y HTML salen de los mismos renglones. Nada de esto lleva la CLABE ni sus
// últimos cuatro: el correo avisa, y quien lo lea no debe poder usarlo. Unas plantillas de React Email (TRD §7.5) se deciden con T-310.

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface MailCopy {
  clabeNotice: {
    subject: string;
    intro: string;
    wait: (hours: number) => string;
    yours: string;
    notYours: string;
    recoverLabel: string;
    reviewLabel: string;
  };
}

const clabeParams = z.object({ hours: z.number().int().min(1) }).strict();

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function clabeNotice(params: unknown, site: string, copy: MailCopy["clabeNotice"]): RenderedMail | null {
  const parsed = clabeParams.safeParse(params);
  if (!parsed.success) return null;
  const paragraphs = [copy.intro, copy.wait(parsed.data.hours), copy.yours, copy.notYours];
  const links = [
    { label: copy.recoverLabel, url: `${site}${ROUTES.recover}` },
    { label: copy.reviewLabel, url: `${site}${ROUTES.portalTaxData}` },
  ];
  return {
    subject: copy.subject,
    text: [...paragraphs, ...links.map((link) => `${link.label}: ${link.url}`)].join("\n\n"),
    html: [
      ...paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`),
      ...links.map((link) => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`),
    ].join(""),
  };
}

/** El correo armado, o nulo si la fila no tiene forma: es una falla de código, y reintentarla no la arregla. */
export function renderMail(template: string, params: unknown, site: string, copy: MailCopy): RenderedMail | null {
  return template === "CO-27" ? clabeNotice(params, site, copy.clabeNotice) : null;
}
