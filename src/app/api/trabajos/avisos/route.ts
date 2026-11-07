import { sendQueuedMail } from "@/app/_lib/mail-requests";
import { bearerToken } from "@/app/_lib/request-context";
import { billingSweepAllowed, sweepBillingEvents } from "@/services/billing/billing";

// El barrido de los avisos de Stripe (T-303): el respaldo de lo que falló de paso y Stripe ya no reenvía. Como el de la salida de correo, lo pide Vercel Cron con un
// GET y `CRON_SECRET`; sin esa llave contesta lo mismo que una ruta que no existe. No recibe nada: procesa lo que la base dice que toca. La duración va escrita: el
// barrido se detiene a los 45 s, y lo que sigue cabe en el resto.

export const maxDuration = 60;

export async function GET(): Promise<Response> {
  if (!billingSweepAllowed(await bearerToken())) return new Response(null, { status: 404 });
  const swept = await sweepBillingEvents();
  if (swept) await sendQueuedMail();
  return new Response(null, { status: swept ? 204 : 503, headers: { "cache-control": "no-store" } });
}
