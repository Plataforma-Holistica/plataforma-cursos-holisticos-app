import { after } from "next/server";

import { sendQueuedMail } from "@/app/_lib/mail-requests";
import { readCappedBody } from "@/app/_lib/request-body";
import { stripeSignature } from "@/app/_lib/request-context";
import { noteOversizedBody, receiveStripeEvent, stripeWebhookEnabled } from "@/services/billing/billing";

// Los avisos de Stripe (T-303; RF-208; TRD §6.3 y §9.6). Es la otra excepción a «las rutas solo atienden lecturas»: Stripe solo sabe mandar un POST. No usa sesión ni
// cookies, y el proxy no la toca (su matcher la deja fuera): lo que la cuida es la firma, sobre el cuerpo crudo, con tope de tamaño. Sin las llaves de Stripe contesta
// lo mismo que una ruta que no existe. Lo que el aviso encoló (un recibo) sale detrás de la respuesta, y lo que pasó del tope de la entrega termina ahí también,
// con su recibo. La duración va escrita: 60 s caben en cualquier configuración del plan, y cubren el tope de 8 s y lo que sigue.

export const maxDuration = 60;

const MAX_BYTES = 512 * 1024;
const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  if (!stripeWebhookEnabled()) return new Response(null, { status: 404 });
  const body = await readCappedBody(request, MAX_BYTES);
  if (body === null) {
    await noteOversizedBody();
    return new Response(null, { status: 413, headers: NO_STORE });
  }
  const delivery = await receiveStripeEvent(body, await stripeSignature());
  // Lo que terminó tarde pudo encolar un recibo: sale cuando termine, y no espera al reenvío de Stripe ni al correo del día.
  const rest = delivery.rest;
  if (rest !== undefined) after(() => rest.then(() => sendQueuedMail()));
  if (delivery.status === 200) await sendQueuedMail();
  return new Response(null, { status: delivery.status, headers: NO_STORE });
}
