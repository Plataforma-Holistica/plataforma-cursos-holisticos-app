import { House, UserRound } from "lucide";
import Link from "next/link";

import { messages, t } from "@/messages";
import { ROUTES } from "@/services/account/navigation";
import { cx } from "@/ui/cx";
import { Icon } from "@/ui/icon";

// La barra del alumno (`AppHeader` y `BottomNav`, diseño, sección 5; T-210): arriba en
// escritorio, abajo y fija en el teléfono. Por ahora, Inicio y Cuenta: Explorar llega con la
// segunda solicitud de T-210, y la Cuenta ocupa el lugar de Perfil (PA-23) mientras no exista.
// Una sola lista de enlaces, que el CSS acomoda: así no se repite para el lector de pantalla.

const text = messages.browse.nav;

const LINKS = [
  { href: ROUTES.home, label: text.home, icon: House },
  { href: ROUTES.account, label: text.account, icon: UserRound },
] as const;

export function StudentNav({ current }: { current?: (typeof LINKS)[number]["href"] }) {
  return (
    <header className="border-border sm:border-b">
      <div className="mx-auto flex max-w-page items-center justify-between gap-6 px-4 py-3 sm:px-8">
        <Link href={ROUTES.home} className="font-display text-h3 text-text">
          {t(text.brand)}
        </Link>
        <nav
          aria-label={text.label}
          className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface-1 sm:static sm:border-0 sm:bg-transparent"
        >
          <ul className="flex justify-around sm:justify-end sm:gap-2">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={current === link.href ? "page" : undefined}
                  className={cx(
                    "flex min-h-touch flex-col items-center justify-center gap-1 px-4 py-2 text-caption text-text-2 hover:text-text sm:flex-row sm:text-body",
                    current === link.href && "text-text sm:underline sm:underline-offset-8",
                  )}
                >
                  <Icon icon={link.icon} className="sm:hidden" />
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
