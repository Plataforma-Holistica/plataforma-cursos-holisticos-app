import type { ReactNode } from "react";

import { SideFrame } from "@/app/_lib/side-nav";
import { messages } from "@/messages";
import { ROUTES } from "@/services/account/navigation";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// El marco de toda pantalla del portal del maestro (diseño, `SideNav`; decisión de Sergio del
// 2026-10-29: mínimo, con lo que existe). Cada tarea le suma su entrada: el panel (T-408), los pagos, la
// cuenta. No es un armazón de Next: lo pinta cada pantalla después de su guarda.
//
// El menú lateral es el mismo que el de administración (`SideFrame`, con el logotipo desde T-614). Si el
// maestro está suspendido, la franja de solo lectura va arriba del contenido.

const text = messages.portal.nav;

export type PortalEntry =
  | typeof ROUTES.portal
  | typeof ROUTES.portalCourses
  | typeof ROUTES.portalPayouts
  | typeof ROUTES.portalTaxData
  | typeof ROUTES.portalAccount;

const LINKS = [
  { href: ROUTES.portal, label: text.home },
  { href: ROUTES.portalCourses, label: text.courses },
  { href: ROUTES.portalPayouts, label: text.payouts },
  { href: ROUTES.portalTaxData, label: text.taxData },
  { href: ROUTES.portalAccount, label: text.account },
] as const;

/** La franja de solo lectura del maestro suspendido (diseño, `Banner` de aviso). La reusa el inicio del portal. */
export function ReadOnlyBanner() {
  return (
    <div role="status" className="sticky top-0 z-10 border-b border-warning bg-warning-bg px-4 py-3 text-body text-text sm:px-8">
      {messages.portal.readOnly}
    </div>
  );
}

export function PortalFrame({ current, readOnly, children }: { current: PortalEntry; readOnly: boolean; children: ReactNode }) {
  return (
    <SideFrame home={ROUTES.portal} groups={[{ links: LINKS }]} current={current} text={text} banner={readOnly && <ReadOnlyBanner />}>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-8 px-4 py-10 outline-none sm:px-8">
        {children}
      </main>
    </SideFrame>
  );
}
