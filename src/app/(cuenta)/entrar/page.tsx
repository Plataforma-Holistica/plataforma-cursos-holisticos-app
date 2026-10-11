import type { Metadata } from "next";

import { visitorOnly } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages } from "@/messages";
import { RETURN_PARAM } from "@/services/account/navigation";
import { readNotice, type Notice } from "@/services/account/notice";

import { SignInScreen } from "./screen";

// PA-11 · Iniciar sesión (`/entrar`). Quien ya tiene sesión se va a su inicio.

const text = messages.account;

export const metadata: Metadata = { title: text.signIn.pageTitle };

// El aviso que dejó la pantalla anterior. Llega como una clave en una cookie de un minuto;
// el texto se pone aquí. Una clave que esta pantalla no espera no dice nada.
const NOTICES: Partial<Record<Notice, string>> = {
  password_changed: text.signIn.noticePasswordChanged,
  account_ready: text.signIn.noticeAccountReady,
};

type Params = Record<string, string | string[] | undefined>;

export default async function SignInPage({ searchParams }: { searchParams: Promise<Params> }) {
  await visitorOnly();
  const returnTo = (await searchParams)[RETURN_PARAM];
  const notice = readNotice(await cookieReader());

  return (
    <SignInScreen
      // Tal como llegó: la acción lo valida al entrar. Repetido en la dirección no es un destino.
      returnTo={typeof returnTo === "string" ? returnTo : ""}
      notice={notice === null ? null : (NOTICES[notice] ?? null)}
    />
  );
}
