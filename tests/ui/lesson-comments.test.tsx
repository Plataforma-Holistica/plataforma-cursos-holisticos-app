import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LessonComments, type LessonCommentsProps } from "@/app/_comments/lesson-comments";
import { avatarOf } from "@/app/_comments/view";
import { COMMENT_FIELDS, IDLE_COMMENTS, type CommentsState } from "@/app/cursos/[slug]/lecciones/[leccion]/comment-outcomes";
import type { CommentThread, CommentView } from "@/services/comments/comments";

// Los comentarios de la lección (PA-22; diseño §5.12; T-501): el hilo, cada comentario, el campo y lo que se pinta con cada
// respuesta de la acción, que aquí está simulada. Lo que contesta la base lo prueban la 93 y la 102; el camino entero, el
// extremo a extremo `comentarios.equipo.ts`.

const LESSON = "a0000000-0000-4000-8000-000000000001";
const BACK = `/cursos/respirar/lecciones/${LESSON}`;
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function comment(n: number, extra: Partial<CommentView> = {}): CommentView {
  return {
    id: id(n),
    name: "Luz M.",
    body: `Texto ${n}`,
    state: "published",
    own: false,
    teacher: false,
    edited: false,
    createdAt: "2026-11-03T18:00:00.000000+00:00",
    revision: null,
    ...extra,
  };
}
const thread = (n: number, extra: Partial<CommentView> = {}, replies: CommentView[] = [], more = false): CommentThread => ({
  ...comment(n, extra),
  replies: { items: replies, more },
});

function setup(view: Partial<LessonCommentsProps["view"]> = {}, action: LessonCommentsProps["action"] = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1 }))) {
  const props: LessonCommentsProps = {
    slug: "respirar",
    lessonId: LESSON,
    back: BACK,
    teacherName: "Ana Robles",
    action,
    view: {
      count: 0,
      items: [],
      next: null,
      paged: false,
      pagedThread: null,
      here: BACK,
      cursor: null,
      me: { teacher: false, pseudonym: "Luz M." },
      write: { kind: "ok" },
      ...view,
    },
  };
  render(<LessonComments {...props} />);
  return { action, user: userEvent.setup() };
}

describe("el hilo (CommentThread)", () => {
  it("dice cuántos hay, del más reciente al más antiguo, con las respuestas debajo de su comentario", () => {
    setup({ count: 3, items: [thread(1, {}, [comment(2, { name: "Ana Robles", teacher: true })]), thread(3, { name: "Beto" })] });
    expect(screen.getByRole("heading", { name: "3 comentarios" })).toBeInTheDocument();
    const articles = screen.getAllByRole("article");
    expect(articles.map((article) => article.getAttribute("aria-label"))).toEqual(["Luz M.", "Ana Robles", "Beto"]);
    // La respuesta va dentro del hilo de su comentario.
    expect(within(articles[0]!).getByRole("article", { name: "Ana Robles" })).toBeInTheDocument();
  });

  it("uno solo se dice en singular, y sin ninguno, la invitación a empezar", () => {
    setup({ count: 1, items: [thread(1)] });
    expect(screen.getByRole("heading", { name: "1 comentario" })).toBeInTheDocument();
  });

  it("vacío", () => {
    setup();
    expect(screen.getByText("Nadie ha comentado esta lección. Si quieres, empieza tú.")).toBeInTheDocument();
  });

  it("de 20 en 20: «Ver más comentarios» lleva a la página siguiente, y una página que no es la primera vuelve a «Más recientes»", () => {
    setup({ count: 40, items: [thread(1)], next: `2026-11-03T18:00:00.000000+00:00_${id(1)}`, paged: true });
    expect(screen.getByRole("link", { name: "Ver más comentarios" })).toHaveAttribute(
      "href",
      `${BACK}?comentarios=${encodeURIComponent(`2026-11-03T18:00:00.000000+00:00_${id(1)}`)}#comentarios`,
    );
    expect(screen.getByRole("link", { name: "Más recientes" })).toHaveAttribute("href", `${BACK}#comentarios`);
  });

  it("las respuestas que no caben: «Ver más respuestas» lleva a las siguientes de ese comentario", () => {
    setup({ count: 1, items: [thread(1, {}, [comment(2)], true)] });
    expect(screen.getByRole("link", { name: "Ver más respuestas" })).toHaveAttribute(
      "href",
      `${BACK}?hilo=${id(1)}&respuestas=${encodeURIComponent(`2026-11-03T18:00:00.000000+00:00_${id(2)}`)}#comentario-${id(1)}`,
    );
  });
});

describe("desde una página que no es la primera", () => {
  const CURSOR = `2026-11-03T18:00:00.000000+00:00_${id(9)}`;

  it("las respuestas siguientes y las primeras se quedan en esa página", () => {
    setup({ count: 40, items: [thread(1, {}, [comment(2)], true)], paged: true, cursor: CURSOR, pagedThread: id(1) });
    expect(screen.getByRole("link", { name: "Ver más respuestas" })).toHaveAttribute(
      "href",
      `${BACK}?comentarios=${encodeURIComponent(CURSOR)}&hilo=${id(1)}&respuestas=${encodeURIComponent(`2026-11-03T18:00:00.000000+00:00_${id(2)}`)}#comentario-${id(1)}`,
    );
    expect(screen.getByRole("link", { name: "Ver las primeras respuestas" })).toHaveAttribute("href", `${BACK}?comentarios=${encodeURIComponent(CURSOR)}#comentario-${id(1)}`);
  });

  it("lo publicado que no está en esta página se dice arriba del hilo", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, written: id(50), notice: { at: { kind: "comment", id: id(50) }, kind: "published" } }));
    const { user } = setup({ count: 40, items: [thread(1)], paged: true, cursor: CURSOR }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Nuevo");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    await waitFor(() => expect(screen.getByText("Tu comentario se publicó.")).toBeInTheDocument(), { timeout: 3_000 });
  });
});

describe("cada comentario (Comment)", () => {
  it("el del maestro del curso lleva «Imparte el curso»", () => {
    setup({ count: 1, items: [thread(1, { name: "Ana Robles", teacher: true })] });
    expect(within(screen.getByRole("article", { name: "Ana Robles" })).getByText("Imparte el curso")).toBeInTheDocument();
  });

  it("el avatar es la inicial, sobre un tono que sale del nombre", () => {
    expect(avatarOf("Luz M.")).toEqual(avatarOf("Luz M."));
    expect(avatarOf("luz")).toMatchObject({ initial: "L" });
    expect(avatarOf("ñandú").initial).toBe("Ñ");
    expect(avatarOf("").initial).toBe("?");
    const tones = new Set(["Ana", "Beto", "Carla", "Dora", "Eli", "Fede", "Gil", "Hugo", "Iris", "Juan", "Kim", "Lía"].map((name) => avatarOf(name).tone));
    for (const tone of tones) expect(tone).toBeGreaterThanOrEqual(1);
    for (const tone of tones) expect(tone).toBeLessThanOrEqual(8);
    expect(tones.size).toBeGreaterThan(1);
  });

  it("lo propio dice «Tú», ofrece editar y borrar, y en revisión lo dice solo a su autor", () => {
    setup({ count: 0, items: [thread(1, { own: true, state: "in_review", revision: 2, edited: true })] });
    const own = screen.getByRole("article", { name: "Tú" });
    expect(within(own).getByText("En revisión")).toBeInTheDocument();
    expect(within(own).getByText("Solo tú lo ves por ahora. Una persona del equipo lo va a leer.")).toBeInTheDocument();
    expect(within(own).getByText("editado")).toBeInTheDocument();
    expect(within(own).getByText("Opciones de tu comentario")).toBeInTheDocument();
    expect(within(own).getByRole("button", { name: "Editar" })).toHaveAttribute("value", `ask-edit:${id(1)}`);
    expect(within(own).getByRole("button", { name: "Borrar" })).toHaveAttribute("value", `ask-delete:${id(1)}`);
  });

  it("en lo ajeno no hay menú hasta T-502, y se puede responder", () => {
    setup({ count: 1, items: [thread(1)] });
    const other = screen.getByRole("article", { name: "Luz M." });
    expect(within(other).queryByRole("button", { name: "Editar" })).toBeNull();
    expect(within(other).getByRole("button", { name: "Responder" })).toHaveAttribute("value", `open-reply:${id(1)}`);
  });

  it("lo propio en revisión no ofrece «Responder»: solo se responde a lo publicado", () => {
    setup({ count: 0, items: [thread(1, { own: true, state: "in_review", revision: 1 })] });
    expect(screen.queryByRole("button", { name: "Responder" })).toBeNull();
  });

  it("lo borrado que se ve por su respuesta dice «Comentario borrado», sin autor y sin «Responder»", () => {
    setup({ count: 1, items: [thread(1, { state: "deleted", name: null, body: null }, [comment(2)])] });
    const gone = screen.getByRole("article", { name: "Comentario borrado" });
    expect(within(gone).queryByRole("button", { name: "Responder" })).toBeNull();
  });

  it("una respuesta no ofrece «Responder»: el nivel es uno, y se responde desde el comentario", () => {
    setup({ count: 1, items: [thread(1, {}, [comment(2, { name: "Beto" })])] });
    expect(within(screen.getByRole("article", { name: "Beto" })).queryByRole("button", { name: "Responder" })).toBeNull();
  });
});

describe("el campo (CommentComposer)", () => {
  it("lleva el contador, la línea de identidad con «Cambiar» y el botón; el formulario dice de qué lección es", () => {
    setup();
    const field = screen.getByRole("textbox", { name: "Escribe un comentario" });
    expect(field).toHaveAttribute("name", COMMENT_FIELDS.body);
    expect(screen.getByText("0 / 4000")).toBeInTheDocument();
    expect(screen.getByText(/Vas a aparecer como Luz M\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cambiar" })).toHaveAttribute("value", "ask-name");
    expect(screen.getByRole("button", { name: "Comentar" })).toHaveAttribute("value", "post");
    const formOf = field.closest("form")!;
    expect(new FormData(formOf).get(COMMENT_FIELDS.course)).toBe("respirar");
    expect(new FormData(formOf).get(COMMENT_FIELDS.lesson)).toBe(LESSON);
  });

  it("sin seudónimo todavía, avisa que lo va a elegir; el maestro aparece con su nombre, sin «Cambiar»", () => {
    setup({ me: { teacher: false, pseudonym: null } });
    expect(screen.getByText("Antes de publicar vas a elegir con qué nombre apareces.")).toBeInTheDocument();
  });

  it("el maestro del curso", () => {
    setup({ me: { teacher: true, pseudonym: null } });
    expect(screen.getByText("Vas a aparecer como Ana Robles, con «Imparte el curso».")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cambiar" })).toBeNull();
  });

  it.each([
    [{ kind: "read_only" }, "Para comentar necesitas una suscripción."],
    [{ kind: "gate", answer: "banned" }, "Por ahora no puedes comentar. Si crees que es un error, escríbenos."],
    [{ kind: "gate", answer: "suspended" }, "Por ahora no puedes escribir aquí como maestro de este curso. Puedes leer los comentarios."],
    [{ kind: "gate", answer: "closed" }, "Por ahora no se pueden publicar comentarios."],
  ] as const)("con %o el campo se sustituye por su texto, y se sigue leyendo", (write, text) => {
    setup({ count: 1, items: [thread(1)], write });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Escribe un comentario" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Responder" })).toBeNull();
    expect(screen.getByRole("article", { name: "Luz M." })).toBeInTheDocument();
  });

  it("el maestro con el aviso pendiente va al portal a aceptarlo", () => {
    setup({ write: { kind: "gate", answer: "needs_notice" } });
    expect(screen.getByRole("link", { name: "Acepta el aviso del maestro" })).toHaveAttribute("href", "/portal");
  });

  it("sin seudónimo no se sustituye nada: el diálogo llega al enviar", () => {
    setup({ write: { kind: "gate", answer: "needs_pseudonym" }, me: { teacher: false, pseudonym: null } });
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toBeInTheDocument();
  });
});

describe("lo escrito y el foco no se pierden", () => {
  it("abrir otra cosa en el hilo no vacía el campo de arriba", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, open: { kind: "reply", parentId: id(1) } }));
    const { user } = setup({ count: 1, items: [thread(1)] }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Un borrador largo");
    await user.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByRole("textbox", { name: "Responde a Luz M." });
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Un borrador largo");
  });

  /** Una acción que contesta, en orden, lo que se le dé. */
  const answers = (...states: Omit<CommentsState, "attempt">[]) => {
    let n = 0;
    return vi.fn(async (): Promise<CommentsState> => ({ ...states[Math.min(n, states.length - 1)]!, attempt: ++n }));
  };
  const BLANK = { open: { kind: "none" }, notice: null, kept: null, written: null } as const;

  it("cancelar el diálogo del nombre deja lo escrito en el campo", async () => {
    const action = answers({ ...BLANK, open: { kind: "name", carry: { parentId: null, body: "Hola" } }, kept: { at: { kind: "new" }, body: "Hola" } }, BLANK);
    const { user } = setup({ me: { teacher: false, pseudonym: null } }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Hola");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 3_000 });
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Hola");
  });

  it("después de «Cambiar» y guardar el nombre, lo escrito sigue en el campo", async () => {
    const action = answers({ ...BLANK, open: { kind: "name", carry: null }, kept: { at: { kind: "new" }, body: "Hola" } }, { ...BLANK, notice: { at: { kind: "thread" }, kind: "name_saved" } });
    const { user } = setup({}, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Hola");
    await user.click(screen.getByRole("button", { name: "Cambiar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    await user.type(within(dialog).getByRole("textbox", { name: "Nombre o seudónimo" }), "Luz");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await screen.findByText("Guardamos tu nombre.");
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Hola");
    expect(screen.getByText("4 / 4000")).toBeInTheDocument();
  });

  it("un envío que falla y después otra cosa del hilo: el texto sigue en el campo", async () => {
    const action = answers({ ...BLANK, notice: { at: { kind: "new" }, kind: "throttled" }, kept: { at: { kind: "new" }, body: "Hola" } }, { ...BLANK, open: { kind: "reply", parentId: id(1) } });
    const { user } = setup({ count: 1, items: [thread(1)] }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Hola");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    await screen.findByText("Escribiste muchos comentarios seguidos. Espera unos minutos y vuelve a intentarlo.");
    await user.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByRole("textbox", { name: "Responde a Luz M." });
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Hola");
  });

  it("un nombre que no sirve y después cancelar: lo escrito sigue en su campo", async () => {
    const action = answers(
      { ...BLANK, open: { kind: "name", carry: { parentId: null, body: "Hola" } }, kept: { at: { kind: "new" }, body: "Hola" } },
      { ...BLANK, open: { kind: "name", carry: { parentId: null, body: "Hola" } }, notice: { at: { kind: "name" }, kind: "name_too_short" }, kept: { at: { kind: "name" }, body: "L" } },
      { ...BLANK, kept: { at: { kind: "new" }, body: "Hola" } },
    );
    const { user } = setup({ me: { teacher: false, pseudonym: null } }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Hola");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    let dialog = await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    await user.type(within(dialog).getByRole("textbox", { name: "Nombre o seudónimo" }), "L");
    await user.click(within(dialog).getByRole("button", { name: "Guardar y publicar" }));
    await screen.findByText("Tiene que tener al menos 2 caracteres.");
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Hola");
    dialog = screen.getByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 3_000 });
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Hola");
  });

  it("lo escrito en una respuesta vuelve si se cierra y se abre otra vez", async () => {
    const action = answers({ ...BLANK, open: { kind: "reply", parentId: id(1) } }, { ...BLANK, open: { kind: "edit", id: id(3) } }, { ...BLANK, open: { kind: "reply", parentId: id(1) } });
    const { user } = setup({ count: 1, items: [thread(1), thread(3, { own: true, revision: 1 })] }, action);
    await user.click(screen.getAllByRole("button", { name: "Responder" })[0]!);
    await user.type(await screen.findByRole("textbox", { name: "Responde a Luz M." }), "Mi respuesta");
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await screen.findByRole("textbox", { name: "Edita tu comentario" });
    await user.click(screen.getAllByRole("button", { name: "Responder" })[0]!);
    expect(await screen.findByRole("textbox", { name: "Responde a Luz M." })).toHaveValue("Mi respuesta");
  });

  it("el diálogo del nombre va junto al campo, antes del hilo, para que sin JavaScript se vea donde se escribió", async () => {
    const action = answers({ ...BLANK, open: { kind: "name", carry: { parentId: null, body: "Hola" } }, kept: { at: { kind: "new" }, body: "Hola" } });
    const { user } = setup({ count: 1, items: [thread(1)], me: { teacher: false, pseudonym: null } }, action);
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    expect(dialog.compareDocumentPosition(screen.getByRole("article", { name: "Luz M." })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("si el campo ya no se pinta, lo que pasó se dice arriba del hilo", async () => {
    const action = answers({ ...BLANK, notice: { at: { kind: "new" }, kind: "closed" } });
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 1 })], write: { kind: "gate", answer: "closed" } }, action);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    expect(await screen.findByText("Por ahora no se pueden publicar comentarios.", { selector: "[role=status] *, [role=status]" })).toBeInTheDocument();
  });

  it("una edición que se cancela no vuelve: al editar otra vez, el campo trae el texto de ahora", async () => {
    const action = answers({ ...BLANK, open: { kind: "edit", id: id(1) } }, BLANK, { ...BLANK, open: { kind: "edit", id: id(1) } });
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 1 })] }, action);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.type(await screen.findByRole("textbox", { name: "Edita tu comentario" }), " descartado");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edita tu comentario" })).toBeNull(), { timeout: 3_000 });
    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(await screen.findByRole("textbox", { name: "Edita tu comentario" })).toHaveValue("Texto 1");
  });

  it("vaciar una edición y guardar: el campo se queda vacío, con su aviso", async () => {
    const action = answers({ ...BLANK, open: { kind: "edit", id: id(1) } }, { ...BLANK, open: { kind: "edit", id: id(1) }, notice: { at: { kind: "edit", id: id(1) }, kind: "empty" }, kept: { at: { kind: "edit", id: id(1) }, body: "" } });
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 1 })] }, action);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.clear(await screen.findByRole("textbox", { name: "Edita tu comentario" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText("Escribe algo antes de enviar.");
    expect(screen.getByRole("textbox", { name: "Edita tu comentario" })).toHaveValue("");
  });

  it("un nombre que no sirve: el foco va a su campo, que dice por qué", async () => {
    const action = answers(
      { ...BLANK, open: { kind: "name", carry: null } },
      { ...BLANK, open: { kind: "name", carry: null }, notice: { at: { kind: "name" }, kind: "name_too_short" }, kept: { at: { kind: "name" }, body: "L" } },
    );
    const { user } = setup({}, action);
    await user.click(screen.getByRole("button", { name: "Cambiar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    await user.type(within(dialog).getByRole("textbox", { name: "Nombre o seudónimo" }), "L");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Nombre o seudónimo" })).toHaveFocus(), { timeout: 3_000 });
    expect(screen.getByRole("textbox", { name: "Nombre o seudónimo" })).toHaveAccessibleDescription(/al menos 2 caracteres/);
  });

  it("guardar una edición y volver a editar: el campo trae el texto del comentario", async () => {
    const action = answers(
      { ...BLANK, open: { kind: "edit", id: id(1) } },
      { ...BLANK, written: id(1), notice: { at: { kind: "comment", id: id(1) }, kind: "published" }, kept: { at: { kind: "edit", id: id(1) }, body: "" } },
      { ...BLANK, open: { kind: "edit", id: id(1) } },
    );
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 2 })] }, action);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.type(await screen.findByRole("textbox", { name: "Edita tu comentario" }), " más");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText("Tu comentario se publicó.");
    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(await screen.findByRole("textbox", { name: "Edita tu comentario" })).toHaveValue("Texto 1");
  });

  it("una respuesta que ya no tiene dónde ir: su aviso y lo escrito se dicen arriba del hilo, para copiarlo", async () => {
    const action = answers({
      ...BLANK,
      open: { kind: "reply", parentId: id(1) },
      notice: { at: { kind: "reply", parentId: id(1) }, kind: "bad_parent" },
      kept: { at: { kind: "reply", parentId: id(1) }, body: "Mi respuesta" },
    });
    const { user } = setup({ count: 1, items: [thread(1, { state: "deleted", name: null, body: null }, [comment(2)]), thread(3, { own: true, revision: 1 })] }, action);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    expect(await screen.findByText("Ese comentario ya no recibe respuestas.")).toBeInTheDocument();
    expect(screen.getByText("Mi respuesta")).toBeInTheDocument();
  });

  it("si el campo se sustituye, lo escrito se muestra para copiarlo", async () => {
    const action = answers({ ...BLANK, notice: { at: { kind: "new" }, kind: "closed" }, kept: { at: { kind: "new" }, body: "Lo que escribí" } });
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 1 })], write: { kind: "gate", answer: "closed" } }, action);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    expect(await screen.findByText("Lo que escribí")).toBeInTheDocument();
    expect(screen.getByText("Esto es lo que escribiste:")).toBeInTheDocument();
  });

  it("con el diálogo del nombre abierto, el campo de donde salió muestra lo que cruza, aunque la pantalla no lo haya guardado", async () => {
    const action = answers({
      ...BLANK,
      open: { kind: "name", carry: { parentId: null, body: "Hola" } },
      notice: { at: { kind: "name" }, kind: "name_too_short" },
      kept: { at: { kind: "name" }, body: "L" },
    });
    const { user } = setup({ me: { teacher: false, pseudonym: null } }, action);
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Hola");
  });

  it("Enter en el campo del nombre guarda, no cancela", async () => {
    const seen: (string | null)[] = [];
    const action = vi.fn(async (_previous: CommentsState, form: FormData): Promise<CommentsState> => {
      seen.push(form.get("do") as string | null);
      return { ...IDLE_COMMENTS, attempt: seen.length, open: { kind: "name", carry: null } };
    });
    const { user } = setup({}, action);
    await user.click(screen.getByRole("button", { name: "Cambiar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    await user.type(within(dialog).getByRole("textbox", { name: "Nombre o seudónimo" }), "Lucía{Enter}");
    await waitFor(() => expect(seen).toEqual(["ask-name", "name"]), { timeout: 3_000 });
  });

  it("lo escrito en una respuesta que cruza el diálogo del nombre no se muestra como perdido", async () => {
    const action = answers({ ...BLANK, open: { kind: "name", carry: { parentId: id(1), body: "Mi respuesta" } }, kept: { at: { kind: "reply", parentId: id(1) }, body: "Mi respuesta" } });
    const { user } = setup({ count: 1, items: [thread(1)], me: { teacher: false, pseudonym: null } }, action);
    await user.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    expect(screen.queryByText("Esto es lo que escribiste:")).toBeNull();
  });

  it("un aviso de un comentario que quedó borrado se dice arriba del hilo", async () => {
    const action = answers({ ...BLANK, notice: { at: { kind: "comment", id: id(1) }, kind: "changed" } });
    const { user } = setup({ count: 1, items: [thread(1, { state: "deleted", name: null, body: null }, [comment(2)]), thread(3, { own: true, revision: 1 })] }, action);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    expect(await screen.findByText("Este comentario cambió en otra pestaña. Revisa cómo quedó.")).toBeInTheDocument();
  });

  it("lo publicado vacía el campo de donde salió", async () => {
    const action = answers({ ...BLANK, written: id(1), notice: { at: { kind: "comment", id: id(1) }, kind: "published" }, kept: { at: { kind: "new" }, body: "" } });
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 1 })] }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Texto 1");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    await screen.findByText("Tu comentario se publicó.");
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("");
    expect(screen.getByText("0 / 4000")).toBeInTheDocument();
  });

  it("al abrir la edición, el foco va a su campo", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, open: { kind: "edit", id: id(1) } }));
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 4 })] }, action);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Edita tu comentario" })).toHaveFocus(), { timeout: 3_000 });
  });

  it("al cerrar la edición, el foco vuelve a su comentario", async () => {
    let answer: CommentsState = { ...IDLE_COMMENTS, attempt: 1, open: { kind: "edit", id: id(1) } };
    const action = vi.fn(async () => answer);
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 4 })] }, action);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await screen.findByRole("textbox", { name: "Edita tu comentario" });
    answer = { ...IDLE_COMMENTS, attempt: 2 };
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("article", { name: "Tú" })).toHaveFocus(), { timeout: 3_000 });
  });

  it("la respuesta lleva la línea de identidad, y el avatar de lo propio sale del seudónimo", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, open: { kind: "reply", parentId: id(1) } }));
    const { user } = setup({ count: 1, items: [thread(1, { name: "Beto" }), thread(3, { own: true, name: "Luz M.", revision: 1 })] }, action);
    await user.click(screen.getAllByRole("button", { name: "Responder" })[0]!);
    const reply = await screen.findByRole("textbox", { name: "Responde a Beto" });
    expect(within(reply.closest("form")!).getByText(/Vas a aparecer como Luz M\./)).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Tú" }).querySelector("[data-avatar]")).toHaveTextContent("L");
  });
});

describe("lo que pinta cada respuesta", () => {
  it("el diálogo del nombre llega vacío y explica; lo escrito cruza en un campo oculto", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, open: { kind: "name", carry: { parentId: null, body: "Hola" } } }));
    const { user } = setup({ me: { teacher: false, pseudonym: null } }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Hola");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Con qué nombre quieres aparecer?" });
    const name = within(dialog).getByRole("textbox", { name: "Nombre o seudónimo" });
    expect(name).toHaveValue("");
    expect(within(dialog).getByText(/no tiene que ser tu nombre real/)).toBeInTheDocument();
    const data = new FormData(name.closest("form")!);
    expect(data.get(COMMENT_FIELDS.carry)).toBe("Hola");
    expect(data.get(COMMENT_FIELDS.carryParent)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Guardar y publicar" })).toHaveAttribute("value", "name");
  });

  it("si no se pudo publicar, el texto se queda y se dice en su campo", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, notice: { at: { kind: "new" }, kind: "throttled" }, kept: { at: { kind: "new" }, body: "Hola" } }));
    const { user } = setup({}, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Hola");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    await waitFor(() => expect(screen.getByText("Escribiste muchos comentarios seguidos. Espera unos minutos y vuelve a intentarlo.")).toBeInTheDocument(), { timeout: 3_000 });
    expect(screen.getByRole("textbox", { name: "Escribe un comentario" })).toHaveValue("Hola");
  });

  it("al publicar, el foco va al comentario nuevo", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, written: id(5), notice: { at: { kind: "comment", id: id(5) }, kind: "published" } }));
    const { user } = setup({ count: 1, items: [thread(5, { own: true, revision: 1 })] }, action);
    await user.type(screen.getByRole("textbox", { name: "Escribe un comentario" }), "Texto 5");
    await user.click(screen.getByRole("button", { name: "Comentar" }));
    await waitFor(() => expect(screen.getByRole("article", { name: "Tú" })).toHaveFocus(), { timeout: 3_000 });
  });

  it("«Responder» abre el campo bajo su comentario, con el botón que dice a qué responde", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, open: { kind: "reply", parentId: id(1) } }));
    const { user } = setup({ count: 1, items: [thread(1)] }, action);
    await user.click(screen.getByRole("button", { name: "Responder" }));
    const reply = await screen.findByRole("textbox", { name: "Responde a Luz M." });
    expect(within(reply.closest("form")!).getByRole("button", { name: "Responder" })).toHaveAttribute("value", `reply:${id(1)}`);
    expect(within(reply.closest("form")!).getByRole("button", { name: "Cancelar" })).toHaveAttribute("value", "cancel");
  });

  it("editar abre lo propio con su texto y la revisión que se vio", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, open: { kind: "edit", id: id(1) } }));
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 4 })] }, action);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    const field = await screen.findByRole("textbox", { name: "Edita tu comentario" });
    expect(field).toHaveValue("Texto 1");
    expect(screen.getByRole("button", { name: "Guardar" })).toHaveAttribute("value", `save:${id(1)}:4`);
  });

  it("borrar pregunta antes, con la revisión que se vio", async () => {
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, open: { kind: "delete", id: id(1) } }));
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 4 })] }, action);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Borrar tu comentario?" });
    expect(within(dialog).getByRole("button", { name: "Sí, borrarlo" })).toHaveAttribute("value", `delete:${id(1)}:4`);
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveAttribute("value", "cancel");
  });

  it.each([
    ["changed", "Este comentario cambió en otra pestaña. Revisa cómo quedó."],
    ["gone", "Ese comentario ya no está."],
    ["deleted", "Borraste tu comentario."],
    ["unavailable", "No pudimos guardar el cambio. Vuelve a intentarlo."],
  ] as const)("el aviso %s se dice", async (kind, text) => {
    const at = kind === "changed" || kind === "unavailable" ? ({ kind: "comment", id: id(1) } as const) : ({ kind: "thread" } as const);
    const action = vi.fn(async (): Promise<CommentsState> => ({ ...IDLE_COMMENTS, attempt: 1, notice: { at, kind } }));
    const { user } = setup({ count: 1, items: [thread(1, { own: true, revision: 1 })] }, action);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument(), { timeout: 3_000 });
  });
});
