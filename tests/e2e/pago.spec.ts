import { expect, test, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { clearCounters, ownerQuery, parameter, person, type Person } from "./support/stack";

// Los planes y la salida a pagar (PA-04, PA-32; FL-04; T-302), con el pago de prueba de local: una página propia hace de la de Stripe
// (`playwright.config.ts`). El criterio de T-302: se vuelve de pagar antes que el aviso, y no hay acceso hasta que llega. El aviso de
// verdad pasa por la bandeja de T-303, que escribe en libros que no se borran: aquí se escribe a mano la suscripción que dejaría, con el
// id que dio el pago de prueba, y eso lo cubre de verdad la integración 117. Con JavaScript y sin él.

test.beforeEach(clearCounters);

/** El total del plan anual como lo pinta PA-04: la cifra vive en el parámetro, no aquí. */
async function annualTotal(): Promise<string> {
  const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format((await parameter("PRECIO_ANUAL")) / 100);
  return `${pesos}, IVA incluido`;
}

async function signIn(page: Page, who: Pick<Person, "email" | "password">, path: string): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** Lo que dejaría el aviso de Stripe: la suscripción de la salida completada, viva. */
async function stripeNoticeArrives(who: Person): Promise<void> {
  const rows = await ownerQuery<{ subscription_id: string }>(
    "select subscription_id from private.checkout_sessions where profile_id = $1 and state = 'completed'",
    [who.id],
  );
  expect(rows).toHaveLength(1);
  await ownerQuery(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'stripe', $2, 'annual', 'active', 'MXN', now() - interval '1 minute', now() + interval '365 days')`,
    [who.id, rows[0]?.subscription_id],
  );
}

test("el visitante ve los planes sin elegir, elige uno y se le ofrece crear su cuenta o entrar, volviendo a ese plan @telefono", async ({ page }) => {
  await page.goto("/planes");
  // El nombre de la marca lo cambia T-615 en el carril B: aquí solo importa la pantalla.
  await expect(page).toHaveTitle(/^Planes · /);
  await expect(page.getByRole("heading", { level: 1, name: "Elige tu plan" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("link", { name: "Elegir el plan Mensual" }).click();
  await expect(page).toHaveURL("/planes?plan=monthly");
  await expect(page.getByRole("heading", { level: 2, name: "Antes de pagar" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ya tengo cuenta" })).toHaveAttribute("href", `/entrar?volver=${encodeURIComponent("/planes?plan=monthly")}`);
  expect(await a11yViolations(page)).toEqual([]);
});

test("paga, vuelve antes que el aviso y no tiene acceso; llega el aviso y lo tiene, y los planes ya no le cobran", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana, `/entrar?volver=${encodeURIComponent("/planes?plan=annual")}`);
  await expect(page).toHaveURL("/planes?plan=annual");
  await expect(page.getByText(await annualTotal())).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // Sin la casilla no sale.
  await page.getByRole("button", { name: "Continuar al pago" }).click();
  await expect(page.getByText("Para continuar, marca que aceptas el cobro recurrente.")).toBeVisible();
  await expect(page).toHaveURL("/planes?plan=annual");

  await page.getByRole("checkbox", { name: /Acepto que el cobro se repite cada año/ }).check();
  await page.getByRole("button", { name: "Continuar al pago" }).click();
  await expect(page).toHaveURL(/\/suscripcion\/prueba\?sesion=cs_test_local[0-9a-f]+$/);
  await page.getByRole("link", { name: "Pagar (prueba)" }).click();

  // Regresó de pagar y el aviso no ha llegado: espera, sin acceso.
  await expect(page).toHaveURL(/\/suscripcion\/confirmando\?sesion=cs_test_local/);
  await expect(page.getByRole("heading", { name: "Estamos confirmando tu pago" })).toBeVisible();
  const before = await page.request.get("/planes");
  expect(await before.text()).not.toContain("Ya tienes acceso a todo el catálogo.");

  // Llega el aviso: la página, que pregunta sola, dice que ya tiene acceso.
  await stripeNoticeArrives(ana);
  await expect(page.getByRole("heading", { name: "Listo. Ya tienes acceso." })).toBeVisible({ timeout: 15_000 });
  await page.goto("/planes?plan=monthly");
  await expect(page.getByText("Ya tienes acceso a todo el catálogo.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar al pago" })).toHaveCount(0);
});

test.describe("sin JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("el formulario llega a la página de pago, y volver sin pagar dice que no se cobró; PA-32 se actualiza a mano", async ({ page }) => {
    const ana = await person();
    await signIn(page, ana, `/entrar?volver=${encodeURIComponent("/planes?plan=monthly")}`);
    await expect(page).toHaveURL("/planes?plan=monthly");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continuar al pago" }).click();
    await expect(page).toHaveURL(/\/suscripcion\/prueba\?sesion=cs_test_local/);
    const pay = await page.getByRole("link", { name: "Pagar (prueba)" }).getAttribute("href");

    await page.getByRole("link", { name: "Cancelar" }).click();
    await expect(page).toHaveURL("/planes?cancelado=1");
    await expect(page.getByText("No se hizo ningún cobro. Puedes intentarlo cuando quieras.")).toBeVisible();

    // La misma salida, todavía abierta: pagar lleva a PA-32, que sin JavaScript ofrece «Actualizar».
    await page.goto(pay ?? "/");
    await expect(page.getByRole("heading", { name: "Estamos confirmando tu pago" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Actualizar" })).toBeVisible();
  });
});

test("la confirmación de otra persona no existe", async ({ page }) => {
  const ana = await person();
  const bea = await person();
  await signIn(page, ana, `/entrar?volver=${encodeURIComponent("/planes?plan=monthly")}`);
  await expect(page).toHaveURL("/planes?plan=monthly");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continuar al pago" }).click();
  await expect(page).toHaveURL(/\/suscripcion\/prueba\?sesion=/);
  const session = new URL(page.url()).searchParams.get("sesion");

  await page.context().clearCookies();
  await signIn(page, bea, "/entrar");
  await expect(page).toHaveURL("/inicio");
  const other = await page.goto(`/suscripcion/confirmando?sesion=${session}`);
  expect(other?.status()).toBe(404);
});
