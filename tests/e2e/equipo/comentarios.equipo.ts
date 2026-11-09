import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// Los comentarios de una lección (PA-22; RF-801, RF-808; FL-15; T-501), en un navegador de verdad: publicar con el diálogo del
// nombre la primera vez, editar y borrar lo propio, responder sin JavaScript, las pestañas del teléfono, lo que queda en
// revisión sin el filtro, que con el interruptor apagado no hay pestaña, y que sin acceso se borra lo propio desde «Mis comentarios» (PA-24). Lo que la base y el servicio deciden lo prueban la
// 93, la 94, la 101 y la 102: aquí, que la pantalla lo lleve hasta ahí y lo pinte.
//
// El interruptor `COMENTARIOS_ABIERTOS` se prende aquí y se apaga al terminar.
// Va con el camino del equipo porque cargar y publicar un curso escriben en la auditoría, que no admite borrado:
// `pnpm test:e2e:equipo` rehace la base al terminar.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const SLUG = "comentarios-e2e";
let lessonUrl = "";
let luz: Person;
let beto: Person;
let switchBefore = false;

/**
 * Prende o apaga los comentarios. El parámetro tiene sus guardianes (quién lo escribe y qué columnas cambian), que también
 * detienen al dueño: se cambia en réplica, como en la integración 101. Va sin parámetros, para que corra en una sola petición.
 */
const setSwitch = (on: boolean) =>
  ownerQuery(
    `begin; set local session_replication_role = replica;
     update public.business_parameters set value = '${on ? "true" : "false"}'::jsonb where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null;
     commit;`,
  );

async function subscribe(who: Person): Promise<void> {
  await ownerQuery(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '1 day', now() + interval '30 days')`,
    [who.id],
  );
}

test.beforeAll(async () => {
  const course = {
    slug: SLUG,
    title: "Curso con comentarios",
    practice: "comentarios-e2e",
    level: "comentarios-nivel",
    modules: [{ title: "Uno", lessons: [{ title: "Respirar", video: { provider: "mux", asset_id: "AssetComentarios", playback_id: "PlaybackComentarios", duration_seconds: 600 } }] }],
  };
  const [loaded] = await ownerQuery<{ answer: string }>(
    `with declared as materialized (
       select set_config('app.actor_kind', 'system', true), set_config('app.local_courses', 'on', true)),
     catalog as materialized (
       select private.system_catalog_add('practices', 'Comentarios e2e'), private.system_catalog_add('levels', 'Comentarios nivel') from declared),
     teacher as materialized (
       select private.system_add_teacher('Maestra de comentarios', 'maestra-comentarios', null) as id from catalog)
     select private.system_load_course((select id from teacher), $1::jsonb) ->> 'answer' as answer from teacher`,
    [JSON.stringify(course)],
  );
  expect(loaded?.answer).toBe("loaded");
  const [found] = await ownerQuery<{ course: string; lesson: string }>(
    "select c.course_id::text as course, l.id::text as lesson from public.published_courses c join public.published_lessons l on l.course_id = c.course_id where c.slug = $1",
    [SLUG],
  );
  const courseId = found?.course ?? "";
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.course_registry set state = 'published', first_published_at = now() where course_id = $1 and (select count(*) from declared) = 1`,
    [courseId],
  );
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.published_courses set is_listed = true where course_id = $1 and (select count(*) from declared) = 1`,
    [courseId],
  );
  lessonUrl = `/cursos/${SLUG}/lecciones/${found?.lesson ?? ""}`;
  // Pide las dos marcas locales que pone `db:login`: sin `comments_accept` nada se acepta, y sin `comments_unfiltered` todo queda en revisión.
  const flags = await ownerQuery<{ flag: string }>("select flag from private.local_flags where flag in ('comments_accept', 'comments_unfiltered') order by flag");
  expect(flags.map((row) => row.flag)).toEqual(["comments_accept", "comments_unfiltered"]);
  const [before] = await ownerQuery<{ value: unknown }>("select value from public.business_parameters where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
  switchBefore = before?.value === true;
  await setSwitch(true);
  luz = await person();
  beto = await person();
  await subscribe(luz);
  await subscribe(beto);
});

test.afterAll(async () => {
  await setSwitch(switchBefore);
});

async function signIn(page: Page, who: Person, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
}

async function inContext(browser: Browser, options: BrowserContextOptions, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext(options);
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test("con JavaScript: la primera vez pide el nombre, publica con el foco en lo nuevo, y se edita lo propio", async ({ page }) => {
  await signIn(page, luz, lessonUrl);
  await expect(page.getByRole("tab")).toHaveText(["Sobre esta lección", "Comentarios (0)"]);
  await page.getByRole("tab", { name: "Comentarios (0)" }).click();
  await expect(page.getByText("Nadie ha comentado esta lección. Si quieres, empieza tú.")).toBeVisible();
  await expect(page.getByText("Antes de publicar vas a elegir con qué nombre apareces.")).toBeVisible();
  await page.getByRole("textbox", { name: "Escribe un comentario" }).fill("Me ayudó a dormir mejor.");
  await page.getByRole("button", { name: "Comentar" }).click();

  const dialog = page.getByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Nombre o seudónimo" })).toHaveValue("");
  await dialog.getByRole("textbox", { name: "Nombre o seudónimo" }).fill("Luz");
  await dialog.getByRole("button", { name: "Guardar y publicar" }).click();

  const mine = page.getByRole("article", { name: "Tú" });
  await expect(mine).toContainText("Me ayudó a dormir mejor.");
  await expect(mine).toBeFocused();
  await expect(page.getByRole("heading", { name: "1 comentario" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Comentarios (1)" })).toBeVisible();
  await expect(page.getByText("Vas a aparecer como Luz.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // El texto del menú es solo para el lector de pantalla: se pulsa el botón que lo lleva.
  await mine.locator("summary").click();
  await mine.getByRole("button", { name: "Editar" }).click();
  const editing = page.getByRole("textbox", { name: "Edita tu comentario" });
  await expect(editing).toHaveValue("Me ayudó a dormir mejor.");
  await editing.fill("Me ayudó a dormir mucho mejor.");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(mine).toContainText("Me ayudó a dormir mucho mejor.");
  await expect(mine).toContainText("editado");
});

test("sin JavaScript: se responde, también con el diálogo del nombre, y vuelve a la lección", async ({ browser }) => {
  await inContext(browser, { javaScriptEnabled: false }, async (page) => {
    await signIn(page, beto, lessonUrl);
    // Sin JavaScript las pestañas se pintan una tras otra.
    const luzComment = page.getByRole("article", { name: "Luz" });
    await expect(luzComment).toContainText("Me ayudó a dormir mucho mejor.");
    await luzComment.getByRole("button", { name: "Responder" }).click();
    await page.getByRole("textbox", { name: "Responde a Luz" }).fill("A mí también.");
    await page.getByRole("button", { name: "Responder", exact: true }).last().click();
    const dialog = page.getByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Nombre o seudónimo" }).fill("Beto");
    await dialog.getByRole("button", { name: "Guardar y publicar" }).click();
    await expect(page).toHaveURL(new RegExp(`${lessonUrl.replaceAll("/", "\\/")}`));
    const reply = page.getByRole("article", { name: "Luz" }).getByRole("article", { name: "Tú" });
    await expect(reply).toContainText("A mí también.");
  });
});

test("en el teléfono, Comentarios es otra pestaña; borrar lo propio con respuesta deja «Comentario borrado»", async ({ browser }) => {
  await inContext(browser, PHONE, async (page) => {
    await signIn(page, luz, lessonUrl);
    await expect(page.getByRole("tab")).toHaveText(["Temario", "Sobre esta lección", /^Comentarios \(\d+\)$/]);
    await page.getByRole("tab", { name: /^Comentarios/ }).click();
    const mine = page.getByRole("article", { name: "Tú" });
    await mine.locator("summary").click();
    await mine.getByRole("button", { name: "Borrar" }).click();
    const dialog = page.getByRole("dialog", { name: "¿Borrar tu comentario?" });
    await dialog.getByRole("button", { name: "Sí, borrarlo" }).click();
    await expect(page.getByText("Borraste tu comentario.")).toBeVisible();
    // Se ve por su respuesta, sin autor.
    const gone = page.getByRole("article", { name: "Comentario borrado" });
    await expect(gone).toBeVisible();
    await expect(gone.getByRole("article", { name: "Beto" })).toContainText("A mí también.");
    await expect(gone.getByRole("button", { name: "Responder" })).toHaveCount(0);
  });
});

test("sin el filtro, lo nuevo queda en revisión: su autor lo ve con la nota, y nadie más", async ({ browser }) => {
  await ownerQuery("delete from private.local_flags where flag = 'comments_unfiltered'");
  try {
    await inContext(browser, {}, async (page) => {
      await signIn(page, beto, lessonUrl);
      await page.getByRole("tab", { name: /^Comentarios/ }).click();
      await page.getByRole("textbox", { name: "Escribe un comentario" }).fill("Una pregunta sobre la postura.");
      await page.getByRole("button", { name: "Comentar" }).click();
      const mine = page.getByRole("article", { name: "Tú" }).filter({ hasText: "Una pregunta sobre la postura." });
      await expect(mine).toContainText("En revisión");
      await expect(mine).toContainText("Solo tú lo ves por ahora. Una persona del equipo lo va a leer.");
    });
    await inContext(browser, {}, async (page) => {
      await signIn(page, luz, lessonUrl);
      await page.getByRole("tab", { name: /^Comentarios/ }).click();
      await expect(page.getByRole("article", { name: "Comentario borrado" })).toBeVisible();
      await expect(page.getByText("Una pregunta sobre la postura.")).toHaveCount(0);
    });
  } finally {
    await ownerQuery("insert into private.local_flags (flag) values ('comments_unfiltered') on conflict do nothing");
  }
});

test("con el interruptor apagado no hay pestaña", async ({ page }) => {
  await setSwitch(false);
  try {
    await signIn(page, luz, lessonUrl);
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Sobre esta lección" })).toBeVisible();
  } finally {
    await setSwitch(true);
  }
});

// «Mis comentarios» (PA-24; decisiones de Sergio del 2026-11-08): quien perdió el acceso a la lección borra lo suyo desde la cuenta.
async function expire(who: Person): Promise<void> {
  await ownerQuery(
    `begin; set local session_replication_role = replica;
     update public.subscriptions set status = 'canceled', current_period_start = now() - interval '90 days', current_period_end = now() - interval '60 days' where profile_id = '${who.id}';
     commit;`,
  );
}

test("sin acceso a la lección, Beto llega desde «Cuenta» a lo suyo y borra lo que está en revisión", async ({ browser }) => {
  await expire(beto);
  await inContext(browser, PHONE, async (page) => {
    await signIn(page, beto, "/cuenta");
    await page.getByRole("link", { name: "Ver y borrar lo que escribiste" }).click();
    await expect(page).toHaveURL(/\/cuenta\/comentarios$/);
    await expect(page.getByRole("heading", { level: 1, name: "Mis comentarios" })).toBeVisible();
    const review = page.getByRole("article").filter({ hasText: "Una pregunta sobre la postura." });
    await expect(review).toContainText("En revisión");
    await expect(page.getByRole("article").filter({ hasText: "A mí también." })).toContainText("Respuesta");
    expect(await a11yViolations(page)).toEqual([]);
    await review.getByRole("button", { name: "Borrar" }).click();
    await page.getByRole("dialog", { name: "¿Borrar tu comentario?" }).getByRole("button", { name: "Sí, borrarlo" }).click();
    await expect(page.getByText("Borraste tu comentario.")).toBeVisible();
    await expect(page.getByText("Una pregunta sobre la postura.")).toHaveCount(0);
  });
});

test("sin JavaScript, también se borra desde «Mis comentarios»", async ({ browser }) => {
  await inContext(browser, { javaScriptEnabled: false }, async (page) => {
    await signIn(page, beto, "/cuenta/comentarios");
    const reply = page.getByRole("article").filter({ hasText: "A mí también." });
    await reply.getByRole("button", { name: "Borrar" }).click();
    await page.getByRole("dialog", { name: "¿Borrar tu comentario?" }).getByRole("button", { name: "Sí, borrarlo" }).click();
    await expect(page).toHaveURL(/\/cuenta\/comentarios/);
    await expect(page.getByText("Borraste tu comentario.")).toBeVisible();
    await expect(page.getByText("Todavía no has escrito comentarios.")).toBeVisible();
  });
});

// PA-45 (T-501; RF-609; FL-38): la maestra del curso, con cuenta, responde desde su portal.
let maestra: Person;

/** La maestra del curso de prueba pasa a tener cuenta, con su aviso al día; y una pregunta de `who`, publicada, en la lección. */
async function teacherWithQuestion(who: Person, body: string): Promise<void> {
  if (maestra === undefined) {
    maestra = await person();
    await ownerQuery(
      `begin; set local session_replication_role = replica;
       update public.teachers set profile_id = '${maestra.id}', status = 'active'
        where id = (select teacher_id from public.published_teachers where slug = 'maestra-comentarios');
       commit;`,
    );
    await ownerQuery(
      `with declared as materialized (select set_config('app.actor_id', $1::text, true) as done)
       insert into public.consents (profile_id, legal_document_id, origin)
       select $1::uuid, private.current_legal_document('teacher_privacy_notice'), 'account_settings' from declared`,
      [maestra.id],
    );
  }
  const lesson = lessonUrl.split("/").at(-1) ?? "";
  await ownerQuery(
    `begin; set local session_replication_role = replica;
     insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, status, filter_verdict)
     select l.id, l.course_id, l.teacher_id, '${who.id}', '${body}', 'published', 'pass' from public.published_lessons l where l.id = '${lesson}';
     commit;`,
  );
}

test("PA-45 con JavaScript: la maestra ve lo que espera respuesta y responde desde su portal", async ({ page }) => {
  await teacherWithQuestion(luz, "¿Cuánto dura cada respiración?");
  await signIn(page, maestra, "/portal/comentarios");
  await expect(page.getByRole("heading", { level: 1, name: "Comentarios" })).toBeVisible();
  await page.getByRole("navigation", { name: "Filtros" }).getByRole("link", { name: "Sin responder" }).click();
  await expect(page).toHaveURL(/sin-responder=1/);
  const question = page.getByRole("article", { name: "Luz" }).filter({ hasText: "¿Cuánto dura cada respiración?" });
  await expect(question).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await question.getByRole("button", { name: "Responder" }).click();
  await page.getByRole("textbox", { name: "Responde a Luz" }).fill("Cuatro tiempos al entrar y seis al salir.");
  await page.getByRole("button", { name: "Responder", exact: true }).last().click();
  await expect(page.getByText("Tu comentario se publicó.")).toBeVisible();
  await expect(page.getByText("No tienes comentarios sin responder.")).toBeVisible();
});

test("PA-45 sin JavaScript: también se responde, y la respuesta queda en su hilo", async ({ browser }) => {
  await teacherWithQuestion(beto, "¿Se puede hacer acostado?");
  await inContext(browser, { javaScriptEnabled: false }, async (page) => {
    await signIn(page, maestra, "/portal/comentarios");
    const question = page.getByRole("article", { name: "Beto" }).filter({ hasText: "¿Se puede hacer acostado?" });
    await question.getByRole("button", { name: "Responder" }).click();
    await page.getByRole("textbox", { name: "Responde a Beto" }).fill("Sí, con las rodillas dobladas.");
    await page.getByRole("button", { name: "Responder", exact: true }).last().click();
    await expect(page).toHaveURL(/\/portal\/comentarios/);
    await expect(page.getByRole("article", { name: "Beto" }).filter({ hasText: "¿Se puede hacer acostado?" }).getByRole("article", { name: "Tú" })).toContainText(
      "Sí, con las rodillas dobladas.",
    );
  });
});
