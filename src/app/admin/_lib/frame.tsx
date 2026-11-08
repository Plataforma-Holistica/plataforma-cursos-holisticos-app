import type { ReactNode } from "react";

import { SideFrame, type SideNavGroup } from "@/app/_lib/side-nav";
import { messages, t } from "@/messages";
import { ROUTES } from "@/services/account/navigation";
import type { Capability } from "@/services/account/team";

// El marco de administración (diseño, `SideNav`; T-614, parte 6): el logotipo y el menú agrupado por
// capacidad, solo con los grupos de quien entra (diseño §6.4: el menú solo muestra lo que la persona
// puede abrir). Es una comodidad, como los enlaces que reemplaza: quién entra a cada sección lo decide
// su guarda. Lo pintan el inicio y el comodín, después de la guarda; cada sección trae su `<main>`.
//
// Moderación y soporte todavía no tienen pantallas: sus grupos llegan con ellas.

const text = messages.account.admin;

const GROUPS: readonly { capability: Capability; links: SideNavGroup["links"] }[] = [
  {
    capability: "content",
    links: [
      { href: ROUTES.review, label: text.review },
      { href: ROUTES.adminTeachers, label: t(text.teachers) },
      { href: ROUTES.catalog, label: text.catalog },
    ],
  },
  {
    capability: "finance",
    links: [
      { href: ROUTES.periods, label: text.periods },
      { href: ROUTES.billingEvents, label: text.billingEvents },
      { href: ROUTES.alerts, label: text.alerts },
    ],
  },
  {
    capability: "config",
    links: [
      { href: ROUTES.team, label: text.team },
      { href: ROUTES.legalTexts, label: text.legalTexts },
    ],
  },
];

/** Los grupos de quien entra, en el orden del menú, con el inicio arriba y la cuenta abajo. */
export function adminMenu(capabilities: readonly string[]): SideNavGroup[] {
  const own = GROUPS.filter((group) => capabilities.includes(group.capability)).map((group) => ({
    title: text.capabilities[group.capability],
    links: group.links,
  }));
  return [{ links: [{ href: ROUTES.admin, label: text.nav.home }] }, ...own, { links: [{ href: ROUTES.account, label: text.account }] }];
}

/**
 * La entrada que se marca para una ruta de administración: la de su sección, también desde lo que
 * cuelga de ella (el panel de un periodo marca «Periodos»).
 */
export function adminEntryOf(path: string): string {
  const section = path.split("/")[2];
  return section === undefined ? ROUTES.admin : `${ROUTES.admin}/${section}`;
}

export function AdminFrame({ path, capabilities, children }: { path: string; capabilities: readonly string[]; children: ReactNode }) {
  return (
    <SideFrame home={ROUTES.admin} groups={adminMenu(capabilities)} current={adminEntryOf(path)} text={text.nav}>
      {children}
    </SideFrame>
  );
}
