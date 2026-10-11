import type { Metadata } from "next";
import { connection } from "next/server";

import { longDate } from "@/app/_lib/dates";
import { messages } from "@/messages";
import { isLinkToken } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { slugOfDocType } from "@/services/legal/texts";

import { formFacts } from "../../_lib/link-facts";
import { NoCurrentTextScreen, RegistrationLinkDeadScreen, UnavailableScreen } from "../../_lib/states";

import { completeView } from "./outcomes";
import { CompleteScreen } from "./screen";

// PA-14 · Correo sin verificar, variante «Completa tu cuenta» (`/verificar/[token]`). A
// donde lleva el enlace del correo de registro (CO-01). Es pública: una cuenta sin
// verificar no tiene sesión.
//
// Abrir la página no llama a Auth y no gasta el enlace: solo pinta el formulario. Si el
// enlace caducó o ya se usó, se descubre al enviar. Así el lector de enlaces de un correo,
// o abrirla dos veces, no le quita el enlace a nadie.

export const metadata: Metadata = { title: messages.account.complete.title };

export default async function CompletePage({ params }: { params: Promise<{ token: string }> }) {
  // Se pinta en cada petición, y no se guarda en caché: lleva la huella de un enlace.
  await connection();
  const { token } = await params;
  // Lo que no tiene forma de enlace no llega a la base ni a Auth.
  if (!isLinkToken(token)) return <RegistrationLinkDeadScreen />;

  // Con unos segundos de memoria: la página es pública, y cualquier dirección con forma de
  // enlace llega hasta aquí.
  const facts = await formFacts();
  if (facts.kind === "no_current_text") return <NoCurrentTextScreen withSession={false} />;
  // Reintentar es volver a abrir el mismo enlace, que sigue sin gastarse.
  const self = `${ROUTES.verify}/${token}`;
  if (facts.kind === "unavailable") return <UnavailableScreen retryHref={self} withSession={false} />;

  return <CompleteScreen token={token} view={completeView(facts, { slugOf: slugOfDocType, formatDate: longDate })} />;
}
