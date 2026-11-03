import type { MailSender } from "@/domain/mail/mail";

// El buzón local (Mailpit): en local un correo cae aquí, igual que los del Auth local, y nunca sale de la máquina. Lo que no sea un 2xx se reintenta.

export function createMailpitSender(deps: { url: string; fetch?: typeof fetch }): MailSender {
  const send = deps.fetch ?? fetch;
  return async (mail) => {
    try {
      const response = await send(`${deps.url}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ From: { Email: mail.from }, To: [{ Email: mail.to }], Subject: mail.subject, Text: mail.text, HTML: mail.html }),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok ? "sent" : "retry";
    } catch {
      return "retry";
    }
  };
}
