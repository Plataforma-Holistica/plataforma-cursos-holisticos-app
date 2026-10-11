import type { Metadata } from "next";
import { connection } from "next/server";

import { messages } from "@/messages";
import { isLinkToken } from "@/services/account/account";

import { RecoveryLinkDeadScreen } from "../../_lib/states";

import { ChangePasswordScreen } from "./screen";

// PA-13 · Recuperar contraseña, «cambiar» (`/recuperar/[token]`). A donde lleva el enlace
// del correo de recuperación. Es pública: quien olvidó su contraseña no tiene sesión.
//
// Abrir la página no llama a Auth, no lee la base y no gasta el enlace: solo pinta el
// formulario. Si el enlace caducó o ya se usó, se descubre al guardar.

export const metadata: Metadata = { title: messages.account.recover.changePageTitle };

export default async function ChangePasswordPage({ params }: { params: Promise<{ token: string }> }) {
  // Se pinta en cada petición: una página con la huella de un enlace no se guarda en caché.
  await connection();
  const { token } = await params;
  if (!isLinkToken(token)) return <RecoveryLinkDeadScreen />;
  return <ChangePasswordScreen token={token} />;
}
