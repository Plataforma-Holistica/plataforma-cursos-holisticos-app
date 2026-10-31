import { Menu } from "lucide";
import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";
import { messages } from "@/messages";
import { ROUTES } from "@/services/account/navigation";
import { cx } from "@/ui/cx";
import { Icon } from "@/ui/icon";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// El marco de toda pantalla del portal del maestro (diseño, `SideNav`; decisión de Sergio del
// 2026-10-29: mínimo, con lo que existe). Cada tarea le suma su entrada: el panel (T-408), los pagos, la
// cuenta. No es un armazón de Next: lo pinta cada pantalla después de su guarda.
//
// Fijo a la izquierda desde `lg`; más angosto, una hoja que se abre con «Menú», que sin JavaScript es un
// `<details>`. Si el maestro está suspendido, la franja de solo lectura va arriba del contenido.

const text = messages.portal.nav;

export type PortalEntry = typeof ROUTES.portal | typeof ROUTES.portalCourses;

const LINKS = [
  { href: ROUTES.portal, label: text.home },
  { href: ROUTES.portalCourses, label: text.courses },
] as const;

function Entries({ current }: { current: PortalEntry }) {
  return (
    <ul className="flex flex-col gap-1">
      {LINKS.map((link) => (
        <li key={link.href}>
          <Link
            href={link.href}
            aria-current={current === link.href ? "page" : undefined}
            className={cx(
              "flex min-h-touch items-center rounded-md px-3 text-body text-text-2 hover:bg-surface-2 hover:text-text",
              current === link.href && "border-l-2 border-accent bg-surface-2 text-text",
            )}
          >
            {link.label}
          </Link>
        </li>
      ))}
      <li className="mt-4 border-t border-border pt-4">
        <Link href={ROUTES.home} className="flex min-h-touch items-center rounded-md px-3 text-body text-text-2 hover:bg-surface-2 hover:text-text">
          {text.platform}
        </Link>
      </li>
      <li>
        {/* El editor de curso pregunta antes si hay algo sin guardar (`data-leaves`). */}
        <form action={signOutAction} data-leaves="all">
          <button type="submit" className="flex min-h-touch w-full items-center rounded-md px-3 text-left text-body text-text-2 hover:bg-surface-2 hover:text-text">
            {text.signOut}
          </button>
        </form>
      </li>
    </ul>
  );
}

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
    <div className="lg:flex">
      <nav aria-label={text.label} className="border-b border-border lg:sticky lg:top-0 lg:h-screen lg:w-sidenav lg:shrink-0 lg:border-r lg:border-b-0 lg:p-4">
        <details className="group lg:hidden">
          <summary className="flex min-h-touch cursor-pointer list-none items-center gap-2 px-4 text-body text-text">
            <Icon icon={Menu} />
            {text.menu}
          </summary>
          <div className="px-4 pb-4">
            <Entries current={current} />
          </div>
        </details>
        <div className="hidden lg:block">
          <Entries current={current} />
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        {readOnly && <ReadOnlyBanner />}
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-8 px-4 py-10 outline-none sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
