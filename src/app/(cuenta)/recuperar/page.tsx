import type { Metadata } from "next";

import { cookieReader } from "@/app/_lib/request-context";
import { messages } from "@/messages";
import { readNotice, type Notice } from "@/services/account/notice";

import { RecoverScreen } from "./screen";

// PA-13 · Recuperar contraseña, «pedir» (`/recuperar`). Es pública y se pinta haya o no
// sesión: quien olvidó su contraseña puede tener una sesión abierta en este navegador. No
// lee nada de la base.

const text = messages.account.recover;

export const metadata: Metadata = { title: text.pageTitle };

// El aviso que dejó la pantalla anterior. Llega como una clave en una cookie de un minuto;
// el texto se pone aquí. Una clave que esta pantalla no espera no dice nada.
const NOTICES: Partial<Record<Notice, string>> = {
  choose_password: text.noticeChoosePassword,
};

export default async function RecoverPage() {
  const notice = readNotice(await cookieReader());
  return <RecoverScreen notice={notice === null ? null : (NOTICES[notice] ?? null)} />;
}
