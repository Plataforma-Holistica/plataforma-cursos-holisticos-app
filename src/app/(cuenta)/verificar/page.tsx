import type { Metadata } from "next";

import { cookieReader } from "@/app/_lib/request-context";
import { messages } from "@/messages";
import { readRegistration } from "@/services/account/pending-registration";

import { pendingRequestFacts } from "../_lib/link-facts";

import { CheckMailScreen } from "./screen";

// PA-14 · Correo sin verificar, variante «Revisa tu correo» (`/verificar`). A donde lleva
// siempre el registro. Es pública y se pinta haya o no sesión: una cuenta sin verificar no
// tiene ninguna.
//
// El correo llega en una cookie corta, no en la dirección. Sin ella (caducó, o la página se
// abrió en otro navegador) se pinta el texto genérico, y no se lee nada de la base.

export const metadata: Metadata = { title: messages.account.checkMail.title };

export default async function CheckMailPage() {
  const pending = readRegistration(await cookieReader());
  if (pending === null) return <CheckMailScreen email={null} lifetimeSeconds={null} wait={null} />;

  // Solo para decir cuánto dura el enlace y cuándo se puede reenviar.
  const facts = await pendingRequestFacts(pending.sentAt);
  return <CheckMailScreen email={pending.email} lifetimeSeconds={facts?.lifetimeSeconds ?? null} wait={facts?.wait ?? null} />;
}
