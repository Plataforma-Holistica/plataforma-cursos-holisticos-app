// El buzón de la pila local (Mailpit): ahí caen los correos que manda el Auth local. Las
// pruebas leen de aquí el enlace que una persona recibiría, y comprueban qué plantilla
// salió de verdad, que es lo único que demuestra que `supabase/config.toml` la tomó.

const base = () => process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

export interface Mail {
  subject: string;
  html: string;
  text: string;
}

interface MailSummary {
  ID: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${base()}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`El buzón local contestó ${response.status} a ${path}.`);
  return (await response.json()) as T;
}

/** Los correos que hay para una dirección, del más viejo al más nuevo. */
export async function mailsTo(address: string): Promise<Mail[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const found = await getJson<{ messages: MailSummary[] }>(`/api/v1/search?query=${query}`);
  const mails: Mail[] = [];
  for (const summary of [...found.messages].reverse()) {
    const full = await getJson<{ Subject: string; HTML: string; Text: string }>(
      `/api/v1/message/${summary.ID}`,
    );
    mails.push({ subject: full.Subject, html: full.HTML, text: full.Text });
  }
  return mails;
}

/** Espera a que una dirección tenga al menos `count` correos. Falla si no llegan. */
export async function waitForMails(address: string, count = 1, timeoutMs = 8_000): Promise<Mail[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mails = await mailsTo(address);
    if (mails.length >= count) return mails;
    if (Date.now() >= deadline) {
      throw new Error(`Se esperaban ${count} correos y llegaron ${mails.length}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** El último correo de una dirección, esperando a que llegue. */
export async function lastMailTo(address: string, count = 1): Promise<Mail> {
  const mails = await waitForMails(address, count);
  const last = mails.at(-1);
  if (!last) throw new Error("El buzón no devolvió el correo.");
  return last;
}

/** Las direcciones a las que apunta un correo, sin repetir. */
export function linksIn(mail: Mail): string[] {
  const found = [...mail.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
  return [...new Set(found)];
}

/**
 * La huella del enlace de un correo de verificación o de recuperación: el último segmento
 * de la dirección que lleva a `/verificar/` o a `/recuperar/`.
 */
export function tokenHashIn(mail: Mail, route: "verificar" | "recuperar"): string {
  const prefix = `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/${route}/`;
  const link = linksIn(mail).find((href) => href.startsWith(prefix));
  if (!link) throw new Error(`El correo no trae un enlace a /${route}/.`);
  return link.slice(prefix.length);
}
