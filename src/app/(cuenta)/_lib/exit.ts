import "server-only";

import { redirect } from "next/navigation";

import { forgetBrowserProofs, signOut, type CookieJar } from "@/services/account/account";
import { leaveNotice, type Notice } from "@/services/account/notice";

// Cómo sale una acción de la cuenta hacia otra pantalla. Va en un solo lugar para que todo
// pase siempre, y en este orden: la sesión que ya no vale se cierra, las pruebas de ese
// navegador se olvidan si la persona pidió salir, el aviso para la pantalla siguiente se
// deja, y solo entonces se redirige.

export interface Exit {
  /** A dónde. Ya validado: sale de la tabla de la pantalla, nunca directo del formulario. */
  to: string;
  /** Lo que la pantalla siguiente tiene que decir, o nulo. */
  notice: Notice | null;
  /** La guarda dijo que la sesión de esta petición ya no vale: se cierra antes de irse. */
  closeSession?: boolean;
  /**
   * La persona pidió salir de ese navegador: se lleva además el resguardo del buzón y el
   * factor a medias. Una sesión que la guarda rechazó no lo pide: puede ser la que quedó de
   * antes de probar el buzón.
   */
  forgetProofs?: boolean;
}

/** Sale hacia otra pantalla. No regresa: `redirect` lanza. */
export async function leaveFor(jar: CookieJar, exit: Exit): Promise<never> {
  if (exit.closeSession === true) await signOut(jar);
  if (exit.forgetProofs === true) forgetBrowserProofs(jar);
  if (exit.notice !== null) leaveNotice(jar, exit.notice);
  redirect(exit.to);
}
