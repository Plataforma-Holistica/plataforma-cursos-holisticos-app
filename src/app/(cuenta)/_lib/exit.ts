import "server-only";

import { redirect } from "next/navigation";

import { signOut, type CookieJar } from "@/services/account/account";
import { leaveNotice, type Notice } from "@/services/account/notice";

// Cómo sale una acción de la cuenta hacia otra pantalla. Va en un solo lugar para que las
// tres cosas pasen siempre, y en este orden: la sesión que ya no vale se cierra, el aviso
// para la pantalla siguiente se deja, y solo entonces se redirige.

export interface Exit {
  /** A dónde. Ya validado: sale de la tabla de la pantalla, nunca directo del formulario. */
  to: string;
  /** Lo que la pantalla siguiente tiene que decir, o nulo. */
  notice: Notice | null;
  /** La guarda dijo que la sesión de esta petición ya no vale: se cierra antes de irse. */
  closeSession?: boolean;
}

/** Sale hacia otra pantalla. No regresa: `redirect` lanza. */
export async function leaveFor(jar: CookieJar, exit: Exit): Promise<never> {
  if (exit.closeSession === true) await signOut(jar);
  if (exit.notice !== null) leaveNotice(jar, exit.notice);
  redirect(exit.to);
}
