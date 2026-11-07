import { sendQueuedMail } from "@/app/_lib/mail-requests";
import { readCappedBody } from "@/app/_lib/request-body";
import { stripeSignature } from "@/app/_lib/request-context";
import { receiveStripeEvent, stripeWebhookEnabled } from "@/services/billing/billing";

// Los avisos de Stripe (T-303; RF-208; TRD §6.3 y §9.6). Es la otra excepción a «las rutas solo atienden lecturas»: Stripe solo sabe mandar un POST. No usa sesión ni
// cookies, y el proxy no la toca (su matcher la deja fuera): lo que la cuida es la firma, sobre el cuerpo crudo, con tope de tamaño. Sin las llaves de Stripe contesta
// lo mismo que una ruta que no existe. Lo que el aviso encoló (un recibo) sale detrás de la respuesta.

const MAX_BYTES = 512 * 1024;
const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  if (!stripeWebhookEnabled()) return new Response(null, { status: 404 });
  const body = await readCappedBody(request, MAX_BYTES);
  if (body === null) return new Response(null, { status: 413, headers: NO_STORE });
  const status = await receiveStripeEvent(body, await stripeSignature());
  if (status === 200) await sendQueuedMail();
  return new Response(null, { status, headers: NO_STORE });
}
