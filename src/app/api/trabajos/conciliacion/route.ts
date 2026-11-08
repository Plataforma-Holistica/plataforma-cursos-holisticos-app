import { bearerToken } from "@/app/_lib/request-context";
import { billingSweepAllowed, sweepReconciliations } from "@/services/billing/billing";

// La conciliación de cada día con Stripe (T-303, cuarta solicitud): compara cada mes terminado y sin cerrar que no tiene una comparación vigente. Como el barrido de
// los avisos, lo pide Vercel Cron con un GET y `CRON_SECRET`; sin esa llave contesta lo mismo que una ruta que no existe. No depende del orden con ese barrido:
// lo que frena por los avisos lo dice el cierre aparte. La lista de Stripe se corta a los 40 s; lo que sigue cabe en el resto.

export const maxDuration = 60;

export async function GET(): Promise<Response> {
  if (!billingSweepAllowed(await bearerToken())) return new Response(null, { status: 404 });
  const whole = await sweepReconciliations();
  return new Response(null, { status: whole ? 204 : 503, headers: { "cache-control": "no-store" } });
}
