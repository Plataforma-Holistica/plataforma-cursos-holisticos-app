import "server-only";

import { after } from "next/server";

import { createAccountServices } from "@/services/account/account";

// Pedir el correo de registro y el de recuperación, armados para las pantallas (TRD §9.2,
// fila «Registro»; flujo de la app FL-02 y FL-06).
//
// El servicio no los entrega ya armados a propósito: lo que se le contesta a quien pide un
// correo no puede depender de si ese correo tiene cuenta, y Auth tarda distinto en cada
// caso. Por eso la llamada a Auth corre detrás de la respuesta, y quien tiene la petición
// es quien sabe cómo: aquí, con `after()` de Next.

/**
 * Corre un trabajo cuando la respuesta ya salió. Si Next no puede encolarlo (no hay una
 * petición en curso), lo corre en el acto: para entonces el envío ya está anotado en los
 * contadores, y sin la llamada a Auth quedaría anotado un correo que nunca salió.
 */
export function deferAfterResponse(work: () => Promise<void>): Promise<void> {
  try {
    after(work);
  } catch {
    return work();
  }
  return Promise.resolve();
}

export const { requestRegistration, requestRecovery } = createAccountServices({ defer: deferAfterResponse });
