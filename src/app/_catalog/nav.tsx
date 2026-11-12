import { BookOpenText, Compass, Heart, House, LayoutDashboard, UserRound } from "lucide";
import Link from "next/link";

import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";
import type { NavAccess } from "@/services/account/nav-access";
import { messages, t } from "@/messages";
import { ROUTES } from "@/services/account/navigation";
import { cx } from "@/ui/cx";
import { Icon } from "@/ui/icon";
import { Wordmark } from "@/ui/wordmark";

import { PersonMenu } from "./person-menu";

// La barra del alumno, una sola en todas sus pantallas (diseño, sección 5; T-210; T-616, solicitud 2, por las
// quejas de Sergio del 2026-11-10: en Cuenta no había barra, y desde el inicio no había cómo volver al portal
// ni a la administración). Fija arriba y translúcida: el logotipo, Inicio, Explorar y Mi lista; a la derecha,
// «Mi portal» y «Administración» a quien le tocan, y el menú de la persona. En el teléfono la lista de enlaces
// baja y se queda fija abajo, con Cuenta, y los accesos por rol van arriba del menú, como botones con su
// icono (pedido del carril A del 2026-11-11: no solo escondidos en el menú).
//
// Una sola lista de enlaces, que el CSS acomoda: así no se repite para el lector de pantalla. Lo que va dos
// veces (los accesos y Cuenta) se esconde con `hidden` en el ancho que no le toca, y entonces el lector
// tampoco lo lee. Los accesos son una comodidad: quién entra lo decide la guarda de esa pantalla. Las dos
// barras se retiran con el reproductor a pantalla completa propia (`student-top-bar`, `student-bottom-bar`).

const text = messages.browse.nav;

const LINKS = [
  { href: ROUTES.home, label: text.home, icon: House, narrowOnly: false, native: false },
  { href: ROUTES.explore, label: text.explore, icon: Compass, narrowOnly: false, native: false },
  // Un ancla del navegador y no del enrutador: así el bloque queda como `:target` y oye `hashchange`.
  { href: ROUTES.myList, label: text.myList, icon: Heart, narrowOnly: false, native: true },
  { href: ROUTES.account, label: text.account, icon: UserRound, narrowOnly: true, native: false },
] as const;

type Current = typeof ROUTES.home | typeof ROUTES.explore | typeof ROUTES.account;

const ACCESSES = [
  { key: "portal", href: ROUTES.portal, label: text.portal, icon: BookOpenText },
  { key: "admin", href: ROUTES.admin, label: text.admin, icon: LayoutDashboard },
] as const;

const ENTRY = "flex min-h-touch w-full items-center gap-3 rounded-md px-3 text-body text-text-2 hover:bg-surface-2 hover:text-text";

export function StudentNav({ current, access, email }: { current?: Current; access: NavAccess; email: string | null }) {
  const shown = ACCESSES.filter((entry) => access[entry.key]);
  return (
    // El desenfoque va solo desde `sm`: un `backdrop-filter` vuelve a la barra el marco de lo fijo, y la lista de
    // abajo del teléfono quedaría pegada a ella y no a la ventana.
    <header data-student-nav className="student-top-bar sticky top-0 z-(--z-sticky) border-b border-border bg-bg sm:float-plane">
      <div className="mx-auto flex max-w-page items-center gap-6 px-4 py-3 sm:px-8">
        <Link href={ROUTES.home} className="inline-flex min-h-touch items-center text-h3">
          <Wordmark />
        </Link>
        <nav
          aria-label={text.label}
          className="student-bottom-bar fixed inset-x-0 bottom-0 z-(--z-sticky) border-t border-border bg-surface-1 sm:static sm:border-0 sm:bg-transparent"
        >
          <ul className="flex justify-around sm:justify-start sm:gap-2">
            {LINKS.map((link) => {
              const Anchor = link.native ? "a" : Link;
              return (
                <li key={link.href} className={cx(link.narrowOnly && "sm:hidden")}>
                  <Anchor
                    href={link.href}
                    aria-current={current === link.href ? "page" : undefined}
                    className={cx(
                      "flex min-h-touch flex-col items-center justify-center gap-1 px-4 py-2 text-caption text-text-2 hover:text-text sm:flex-row sm:text-body",
                      current === link.href && "text-text sm:underline sm:underline-offset-8",
                    )}
                  >
                    <Icon icon={link.icon} className="sm:hidden" />
                    {link.label}
                  </Anchor>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {shown.map((entry) => (
            <Link
              key={entry.key}
              href={entry.href}
              className="hidden min-h-touch items-center gap-2 rounded-md px-3 text-body text-text-2 hover:bg-surface-2 hover:text-text sm:inline-flex"
            >
              <Icon icon={entry.icon} />
              {entry.label}
            </Link>
          ))}
          <PersonMenu
            className="relative"
            summary={
              <summary className="flex min-h-touch cursor-pointer list-none items-center gap-2 rounded-md px-3 text-body text-text hover:bg-surface-2">
                <Icon icon={UserRound} />
                <span className="max-sm:sr-only">{text.menu}</span>
              </summary>
            }
          >
            <div className="absolute right-0 top-full z-(--z-dropdown) mt-2 flex w-72 flex-col gap-1 rounded-lg border border-border bg-surface-1 p-2 shadow-raised">
              {email !== null && <p className="px-3 py-2 text-body-s break-words text-text-2">{t(messages.account.home.signedInAs, { email })}</p>}
              <ul className="flex flex-col gap-1">
                {shown.map((entry) => (
                  <li key={entry.key} className="sm:hidden">
                    <Link href={entry.href} className={cx(ENTRY, "border border-border text-text")}>
                      <Icon icon={entry.icon} />
                      {entry.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link href={ROUTES.account} className={ENTRY}>
                    {text.account}
                  </Link>
                </li>
                <li>
                  <Link href={ROUTES.myComments} className={ENTRY}>
                    {text.myComments}
                  </Link>
                </li>
                <li className="border-t border-border pt-1">
                  <form action={signOutAction}>
                    <button type="submit" className={cx(ENTRY, "text-left")}>
                      {text.signOut}
                    </button>
                  </form>
                </li>
              </ul>
            </div>
          </PersonMenu>
        </div>
      </div>
    </header>
  );
}
