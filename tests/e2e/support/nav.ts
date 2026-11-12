import { expect, type Page } from "@playwright/test";

// La barra del alumno (T-616, solicitud 2): «Cerrar sesión», Cuenta y Mis comentarios van en el menú de la persona,
// un `<details>` que se abre con «Tu cuenta». En el teléfono, Cuenta también va en la barra de abajo.

/** Abre el menú de la persona en la barra del alumno. */
export async function openPersonMenu(page: Page): Promise<void> {
  const menu = page.locator("[data-student-nav] details");
  // Por el atributo, que se lee también sin JavaScript.
  if ((await menu.getAttribute("open")) === null) {
    await menu.locator("summary").click();
  }
  await expect(menu).toHaveAttribute("open", "");
}

/** Cierra la sesión desde el menú de la barra, como lo haría la persona. */
export async function signOutFromBar(page: Page): Promise<void> {
  await openPersonMenu(page);
  await page.locator("[data-student-nav]").getByRole("button", { name: "Cerrar sesión" }).click();
}

/** Va a la cuenta por la barra: abajo en el teléfono, en el menú en computadora. */
export async function goToAccount(page: Page): Promise<void> {
  const bottom = page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Cuenta", exact: true });
  if (await bottom.isVisible()) {
    await bottom.click();
    return;
  }
  await openPersonMenu(page);
  await page.locator("[data-student-nav] details").getByRole("link", { name: "Cuenta", exact: true }).click();
}
