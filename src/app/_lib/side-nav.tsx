import { Menu } from "lucide";
import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";
import { ROUTES } from "@/services/account/navigation";
import { cx } from "@/ui/cx";
import { Icon } from "@/ui/icon";
import { Wordmark } from "@/ui/wordmark";

// El menú lateral (diseño, `SideNav`; T-614, parte 6) del portal del maestro y de administración: el
// mismo marco para los dos, con el logotipo arriba. No es un armazón de Next: lo pinta cada pantalla
// después de su guarda, con las entradas que le tocan.
//
// Fijo a la izquierda desde `lg`; más angosto, una barra con el logotipo y «Menú», que abre una hoja
// encima del contenido. Sin JavaScript la hoja es un `<details>`.
//
// Arriba de todo, «Ir a mi inicio» y los otros lugares de la persona (en administración, «Mi portal» a quien
// también es maestro; T-616, solicitud 2): antes iba al pie, y no se encontraba cómo volver.

export interface SideNavLink {
  href: string;
  label: string;
}

/** Un grupo de entradas. Sin título van sueltas (el portal); con él, bajo su nombre (administración). */
export interface SideNavGroup {
  title?: string;
  links: readonly SideNavLink[];
}

export interface SideNavText {
  /** El nombre del `<nav>`: «Portal» o «Administración». */
  label: string;
  menu: string;
  platform: string;
  signOut: string;
}

const ENTRY = "flex min-h-touch items-center rounded-md px-3 text-body text-text-2 hover:bg-surface-2 hover:text-text";

// El menú se pinta dos veces (la hoja del teléfono y la columna), así que cada copia nombra sus grupos con su prefijo.
function Entries({
  groups,
  current,
  text,
  others,
  idPrefix,
}: {
  groups: readonly SideNavGroup[];
  current: string;
  text: SideNavText;
  others: readonly SideNavLink[];
  idPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-1 border-b border-border pb-4">
        <li>
          <Link href={ROUTES.home} className={ENTRY}>
            {text.platform}
          </Link>
        </li>
        {others.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className={ENTRY}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
      {groups.map((group, index) => (
        <div key={group.title ?? index} className="flex flex-col gap-1">
          {group.title !== undefined && (
            <p id={`${idPrefix}-${index}`} className="px-3 text-label text-text-3 uppercase">
              {group.title}
            </p>
          )}
          <ul aria-labelledby={group.title !== undefined ? `${idPrefix}-${index}` : undefined} className="flex flex-col gap-1">
            {group.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={current === link.href ? "page" : undefined}
                  className={cx(ENTRY, current === link.href && "border-l-2 border-accent bg-surface-2 text-text")}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <ul className="flex flex-col gap-1 border-t border-border pt-4">
        <li>
          {/* El editor de curso pregunta antes si hay algo sin guardar (`data-leaves`). */}
          <form action={signOutAction} data-leaves="all">
            <button type="submit" className={cx(ENTRY, "w-full text-left")}>
              {text.signOut}
            </button>
          </form>
        </li>
      </ul>
    </div>
  );
}

/**
 * El marco: el menú y, a su lado, lo que pinta la pantalla, que trae su propio `<main>`.
 * @param home A dónde lleva el logotipo: el inicio del portal o el de administración.
 * @param current La entrada que se marca, por su dirección.
 * @param banner Lo que va arriba del contenido, como la franja de solo lectura del maestro suspendido.
 * @param others Los otros lugares de la persona, junto a «Ir a mi inicio».
 */
export function SideFrame({
  home,
  groups,
  current,
  text,
  banner,
  others = [],
  children,
}: {
  home: string;
  groups: readonly SideNavGroup[];
  current: string;
  text: SideNavText;
  banner?: ReactNode;
  others?: readonly SideNavLink[];
  children: ReactNode;
}) {
  return (
    <div className="lg:flex">
      <nav
        aria-label={text.label}
        className="relative border-b border-border lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-sidenav lg:shrink-0 lg:flex-col lg:gap-6 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-4"
      >
        <div className="flex items-center justify-between gap-4 px-4 lg:px-3">
          <Link href={home} className="inline-flex min-h-touch items-center text-h3">
            <Wordmark />
          </Link>
          <details className="lg:hidden">
            <summary className="flex min-h-touch cursor-pointer list-none items-center gap-2 text-body text-text">
              <Icon icon={Menu} />
              {text.menu}
            </summary>
            <div className="absolute inset-x-0 top-full z-(--z-dropdown) border-b border-border bg-surface-1 px-4 pt-2 pb-4">
              <Entries groups={groups} current={current} text={text} others={others} idPrefix="side-nav-sheet" />
            </div>
          </details>
        </div>
        <div className="hidden lg:block">
          <Entries groups={groups} current={current} text={text} others={others} idPrefix="side-nav" />
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        {banner}
        {children}
      </div>
    </div>
  );
}
