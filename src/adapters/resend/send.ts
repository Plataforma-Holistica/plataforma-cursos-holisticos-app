import type { MailSender } from "@/domain/mail/mail";

// Resend, con `fetch` y sin su SDK (T-604; TRD §7.5). La llave de idempotencia dura 24 horas: un reintento dentro de ese plazo no manda otro. Nada lanza, y de lo que
// contesta solo se lee el estado: su mensaje podría traer la dirección.

const API = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export function createResendSender(deps: { apiKey: string; fetch?: typeof fetch }): MailSender {
  const send = deps.fetch ?? fetch;
  return async (mail) => {
    let status: number;
    try {
      const response = await send(API, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json", "idempotency-key": mail.key },
        body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
    } catch {
      return "retry";
    }
    if (status >= 200 && status < 300) return "sent";
    return status === 400 || status === 422 ? "rejected" : "retry";
  };
}
