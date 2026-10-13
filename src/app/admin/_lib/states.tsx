import { ShieldX } from "lucide";

import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import type { Capability } from "@/services/account/team";
import { Button } from "@/ui/button";
import { FullScreenState } from "@/ui/full-screen-state";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// Los estados que sustituyen a una pantalla de administración.

/**
 * PA-88 · Sin permiso: quien es del equipo pidió una sección que pide una capacidad que no
 * tiene. Es distinta de PA-19 a propósito: a alguien del equipo sí se le dice que la sección
 * existe (RF-105). A quien no es del equipo nunca se le pinta: recibe PA-19.
 *
 * No dice quién puede asignarla: solo quien tiene configuración lee las capacidades de otras
 * personas. El menú de administración que el diseño pide llega con sus pantallas.
 */
export function ForbiddenScreen({ capability }: { capability: Capability }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={ShieldX}
        title={t(account.forbidden.title, { capability: account.admin.capabilities[capability] })}
        primaryAction={<Button href={ROUTES.admin}>{account.forbidden.action}</Button>}
      >
        <p>{account.forbidden.body}</p>
      </FullScreenState>
    </main>
  );
}
