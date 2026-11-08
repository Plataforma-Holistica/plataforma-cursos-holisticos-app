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
  receipt: {
    subject: string;
    paid: (cents: number, plan: "monthly" | "annual", chargedAt: string) => string;
    thanks: string;
    accountLabel: string;
  };
  billingAlert: {
    subject: string;
    failed: (count: number, type: string, firstAt: string) => string;
    action: string;
    linkLabel: string;
  };
}

const clabeParams = z.object({ hours: z.number().int().min(1) }).strict();
// Lo que encola la base al registrar un cobro (`billing_apply`): el bruto en centavos, el plan y el instante del cargo.
const receiptParams = z.object({ gross_cents: z.number().int().min(1), plan: z.enum(["monthly", "annual"]), charged_at: z.string().min(1) }).strict();

// Lo que encola la base cuando un aviso de cobro queda fallido (`queue_billing_alert`, T-303): cuántos, y el tipo y la hora del primero. Ni la cuenta ni montos.
const billingAlertParams = z
  .object({ count: z.number().int().min(1), first_type: z.string().min(1).max(100), first_at: z.string().min(1) })
  .strict();

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

// El recibo (CO-03): cuánto, de qué plan y cuándo. La cifra y la fecha las escribe quien da los textos.
function receipt(params: unknown, site: string, copy: MailCopy["receipt"]): RenderedMail | null {
  const parsed = receiptParams.safeParse(params);
  if (!parsed.success || Number.isNaN(Date.parse(parsed.data.charged_at))) return null;
  const { gross_cents, plan, charged_at } = parsed.data;
  const paragraphs = [copy.paid(gross_cents, plan, charged_at), copy.thanks];
  const link = { label: copy.accountLabel, url: `${site}${ROUTES.account}` };
  return {
    subject: copy.subject,
    text: [...paragraphs, `${link.label}: ${link.url}`].join("\n\n"),
    html: [...paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`), `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`].join(""),
  };
}

// El aviso a finanzas (CO-22; FL-62 paso 6): cuántos avisos de cobro no se pudieron procesar, el tipo y la hora del primero, y el enlace a la cola (PA-84).
function billingAlert(params: unknown, site: string, copy: MailCopy["billingAlert"]): RenderedMail | null {
  const parsed = billingAlertParams.safeParse(params);
  if (!parsed.success || Number.isNaN(Date.parse(parsed.data.first_at))) return null;
  const paragraphs = [copy.failed(parsed.data.count, parsed.data.first_type, parsed.data.first_at), copy.action];
  const link = { label: copy.linkLabel, url: `${site}${ROUTES.billingEvents}` };
  return {
    subject: copy.subject,
    text: [...paragraphs, `${link.label}: ${link.url}`].join("\n\n"),
    html: [...paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`), `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`].join(""),
  };
}

/** El correo armado, o nulo si la fila no tiene forma: es una falla de código, y reintentarla no la arregla. */
export function renderMail(template: string, params: unknown, site: string, copy: MailCopy): RenderedMail | null {
  if (template === "CO-27") return clabeNotice(params, site, copy.clabeNotice);
  if (template === "CO-03") return receipt(params, site, copy.receipt);
  if (template === "CO-22") return billingAlert(params, site, copy.billingAlert);
  return null;
}
