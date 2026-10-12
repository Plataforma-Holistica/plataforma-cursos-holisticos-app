"use client";

import { clockTime, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { InlineAlert } from "@/ui/inline-alert";

import { useHydrated } from "./hooks";

// El aviso del freno de intentos, con la hora a la que se puede volver a probar. Lo dicen
// las dos pantallas en las que se comprueba una contraseña: la de entrar (PA-11) y el
// cambio de contraseña de la cuenta (PA-25). Es el mismo freno, y dice lo mismo.

const text = account.signIn;

export function ThrottledAlert({ retryAt }: { retryAt: string }) {
  const hydrated = useHydrated();
  // El servidor no sabe en qué zona está la persona: escribe la hora del centro de México
  // y lo dice. El navegador la vuelve a escribir en la suya.
  const message = hydrated
    ? t(text.throttled, { time: clockTime(retryAt) })
    : t(text.throttledCentral, { time: clockTime(retryAt, PRODUCT_TIME_ZONE) });
  return (
    <InlineAlert tone="danger" live>
      {message}
    </InlineAlert>
  );
}
