import { consentsPath, ROUTES, signInPath } from "@/services/account/navigation";
import type { SessionCheck } from "@/services/account/account";
import type { Notice } from "@/services/account/notice";

// La sesión que no pasó al escribir un comentario o borrarlo (T-501): a entrar, a completar la cuenta, o de vuelta a la pantalla,
// donde decide su guarda. Nulo si no se supo: entonces la pantalla lo dice en su lugar.

export interface SessionExit {
  kind: "redirect";
  to: string;
  notice: Notice | null;
  closeSession: boolean;
}

export function commentSessionExit(check: Exclude<SessionCheck, { kind: "pass" }>, back: string): SessionExit | null {
  switch (check.kind) {
    case "anonymous":
      return { kind: "redirect", to: signInPath(back), notice: null, closeSession: false };
    case "incomplete":
      return { kind: "redirect", to: consentsPath(back), notice: null, closeSession: false };
    case "suspended":
      // La pantalla lo dice: pinta PA-35.
      return { kind: "redirect", to: back, notice: null, closeSession: false };
    case "unavailable":
      return null;
    case "must_sign_out":
      return check.then === "recover"
        ? { kind: "redirect", to: ROUTES.recover, notice: "choose_password", closeSession: true }
        : { kind: "redirect", to: ROUTES.signIn, notice: null, closeSession: true };
  }
}
