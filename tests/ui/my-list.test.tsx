import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MyListLink } from "@/app/_catalog/my-list-link";
import { MY_LIST_ARRIVAL } from "@/app/_catalog/my-list/arrival";
import { MyListBlock, type ListCourse } from "@/app/_catalog/my-list/my-list-block";
import type { ListState } from "@/app/_catalog/my-list/outcomes";
import { SaveCourseButton } from "@/app/_catalog/my-list/save-button";
import { CourseCard } from "@/ui/course-card";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

import { a11yViolations } from "../setup/a11y";

// Mi lista (RF-311; T-210): el botón de la ficha y de explorar, y el carrusel del inicio, con la
// acción simulada. Qué hace cada pantalla con cada respuesta está en outcomes.test.ts; aquí, lo que
// se ve, lo que se dice y a dónde va el foco.

type Action = (previous: ListState, form: FormData) => Promise<ListState>;

/** La región que dice el resultado (el botón trae además la suya, la de «Guardando…»). */
const result = () => {
  const region = screen.getAllByRole("status").find((element) => element.tagName === "P");
  if (region === undefined) throw new Error("Sin la región del resultado.");
  return region;
};

/** Una acción que espera a que la prueba conteste. */
function waitingAction() {
  let answer: (state: ListState) => void = () => undefined;
  const sent: string[] = [];
  const action = vi.fn<Action>((_previous, form) => {
    sent.push(String(form.get("do")));
    return new Promise<ListState>((resolve) => (answer = resolve));
  });
  return { action, sent, answer: (state: ListState) => act(async () => answer(state)) };
}

describe("el botón de guardar (PA-02, PA-21)", () => {
  const button = (props: Partial<Parameters<typeof SaveCourseButton>[0]> & { action: Action }) => (
    <SaveCourseButton slug="respirar" title="Respirar" saved={false} permalink="/cursos/respirar#bloque" {...props} />
  );

  it("dice la acción, y para quien no ve también el curso; la región del resultado existe desde antes", async () => {
    const { container } = render(button({ action: vi.fn() }));
    const save = screen.getByRole("button", { name: "Guardar en mi lista: Respirar" });
    expect(save).toHaveTextContent("Guardar en mi lista");
    expect(save).not.toHaveAttribute("aria-pressed");
    expect(result()).toBeEmptyDOMElement();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("guardado, dice quitar", () => {
    render(button({ action: vi.fn(), saved: true }));
    expect(screen.getByRole("button", { name: "Quitar de mi lista: Respirar" })).toHaveTextContent("Quitar de mi lista");
  });

  it("envía la intención; mientras espera no se deshabilita, conserva el foco y no envía otra vez", async () => {
    const { action, sent, answer } = waitingAction();
    const user = userEvent.setup();
    const { rerender } = render(button({ action }));
    await user.click(screen.getByRole("button", { name: "Guardar en mi lista: Respirar" }));
    const pending = await screen.findByRole("button", { name: "Guardando…" });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toBeEnabled();
    await waitFor(() => expect(pending).toHaveFocus());
    await user.click(pending);
    expect(sent).toEqual(["save:respirar"]);

    await answer({ kind: "saved", slug: "respirar", attempt: 1 });
    // La página se vuelve a pedir y dice que ya está guardado.
    rerender(button({ action, saved: true }));
    const remove = screen.getByRole("button", { name: "Quitar de mi lista: Respirar" });
    await waitFor(() => expect(remove).toHaveFocus());
    expect(remove).not.toHaveAttribute("aria-disabled");
    expect(result()).toHaveTextContent("Guardado en tu lista.");
  });

  it.each([
    ["gone", "Ese curso ya no está disponible."],
    ["unavailable", "No pudimos cambiar tu lista. Inténtalo de nuevo en un momento."],
  ] as const)("%s: se ve y se dice", async (kind, said) => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    render(button({ action }));
    await user.click(screen.getByRole("button", { name: "Guardar en mi lista: Respirar" }));
    await answer({ kind, slug: "respirar", attempt: 1 });
    expect(result()).toHaveTextContent(said);
    expect(screen.getAllByText(said)).toHaveLength(2);
  });

  // El marcador de la esquina (T-616, solicitud 3; revisión de la 3a): el aviso cabe en el ancho de la tarjeta. Se ancla a la
  // franja de la esquina, que mide lo que la tarjeta menos su margen, y no al botón de 44 px, donde un ancho fijo se salía por
  // la izquierda en la columna izquierda del teléfono (a 320 px, 48 px fuera).
  it("como marcador en la esquina de una tarjeta, el aviso de lo que salió mal va a lo ancho de la tarjeta", async () => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    const { container } = render(
      <CourseCard
        href="/cursos/respirar"
        courseKey="respirar"
        title="Respirar"
        teacherName="Ana Robles"
        practice={null}
        levelName={null}
        lessonCount={2}
        corner={button({ action, variant: "icon" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Guardar en mi lista: Respirar" }));
    await answer({ kind: "unavailable", slug: "respirar", attempt: 1 });
    // El que se ve, bajo el botón (el otro es la región que lo dice).
    const box = screen
      .getAllByText("No pudimos cambiar tu lista. Inténtalo de nuevo en un momento.")
      .map((element) => element.closest(".top-full"))
      .find((element) => element !== null);
    expect(box).toHaveClass("inset-x-0");
    expect(box?.className).not.toMatch(/\bw-\d/);
    // Su caja de referencia es la franja de la esquina, a lo ancho de la tarjeta: ni el formulario ni el botón la acotan.
    expect(box?.parentElement).not.toHaveClass("relative");
    const strip = container.querySelector(".top-2.right-2");
    expect(strip).toHaveClass("left-2");
    expect(strip).toContainElement(box as HTMLElement);
  });

  it("mientras va otro envío, lo que dijo el anterior deja de decirse", async () => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    render(button({ action }));
    await user.click(screen.getByRole("button", { name: "Guardar en mi lista: Respirar" }));
    await answer({ kind: "unavailable", slug: "respirar", attempt: 1 });
    await user.click(screen.getByRole("button", { name: "Guardar en mi lista: Respirar" }));
    expect(result()).toBeEmptyDOMElement();
    expect(screen.queryByText("No pudimos cambiar tu lista. Inténtalo de nuevo en un momento.")).not.toBeInTheDocument();
    // React no suelta las acciones que siguen mientras una siga en camino: se termina.
    await answer({ kind: "saved", slug: "respirar", attempt: 2 });
  });
});

describe("el carrusel «Mi lista» del inicio (PA-20)", () => {
  const course = (slug: string, title: string): ListCourse => ({
    slug,
    href: `/cursos/${slug}`,
    title,
    teacherName: "Ana Robles",
    practice: { name: "Meditación", tone: 3 },
    levelName: null,
    lessonCount: 2,
    isOpen: false,
  });
  const A = course("uno", "Uno");
  const B = course("dos", "Dos");
  const C = course("tres", "Tres");

  const page = (action: Action, courses: ListCourse[]) => (
    <main id={MAIN_CONTENT_ID} tabIndex={-1}>
      <button type="button">Otra cosa</button>
      <MyListBlock id="bloque-lista" action={action} courses={courses} permalink="/inicio#bloque-lista" />
    </main>
  );
  const quitar = (title: string) => screen.getByRole("button", { name: `Quitar de mi lista: ${title}` });

  it("pinta los guardados, cada uno con «Quitar» fuera del enlace", async () => {
    const { container } = render(page(vi.fn(), [A, B]));
    const row = screen.getByRole("region", { name: "Mi lista" });
    expect(within(row).getByRole("link", { name: /^Uno/ })).toHaveAttribute("href", "/cursos/uno");
    expect(quitar("Uno")).toHaveTextContent("Quitar");
    expect(quitar("Uno").closest("a")).toBeNull();
    expect((quitar("Uno") as HTMLButtonElement).form).toBe((quitar("Dos") as HTMLButtonElement).form);
    expect(container.querySelector("#bloque-lista")).toContainElement(row);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("vacío no pinta el carrusel, pero su región sigue", () => {
    render(page(vi.fn(), []));
    expect(screen.queryByRole("region", { name: "Mi lista" })).not.toBeInTheDocument();
    expect(result()).toBeEmptyDOMElement();
  });

  // «Mi lista» de la barra del alumno lleva a este bloque (T-616, solicitud 2).
  // Desde T-616 (solicitud 3) la nota es un estado con la flor: su título y qué hacer. Lo que se esconde es el estado entero
  // (`data-list-empty`), no solo su texto.
  it("vacío, dice que no hay nada guardado solo cuando se llega por su ancla", () => {
    const { container } = render(page(vi.fn(), []));
    const note = screen.getByText(/Todavía no guardas ningún curso/).closest<HTMLElement>("[data-list-empty]");
    expect(note).toContainElement(screen.getByText("Usa «Guardar en mi lista» en la ficha de un curso o en Explorar."));
    expect(note?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    // Escondido salvo con `:target`: el inicio sin nada guardado sigue sin «Mi lista» (T-210).
    expect(note).toHaveClass("hidden", "group-target/lista:block");
    // Un grupo con nombre: el de las tarjetas no tiene, y uno sin nombre las encendería todas a la vez.
    expect(container.querySelector("#bloque-lista")).toHaveClass("group/lista");
    expect(container.querySelector("#bloque-lista")).not.toHaveClass("group");
    expect(container.querySelector("#bloque-lista")).toContainElement(note);
  });

  it("vacío, al avisarle la barra que se llegó, lo dice y toma el foco", async () => {
    const { container } = render(page(vi.fn(), []));
    const note = screen.getByText(/Todavía no guardas ningún curso/).closest<HTMLElement>("[data-list-empty]");
    act(() => {
      window.dispatchEvent(new Event(MY_LIST_ARRIVAL));
    });
    await waitFor(() => expect(note).toHaveClass("block"), { timeout: 3_000 });
    expect(note).not.toHaveClass("hidden");
    await waitFor(() => expect(container.querySelector("#bloque-lista")).toHaveFocus(), { timeout: 3_000 });
  });

  it("con algo guardado no pinta la nota", () => {
    render(page(vi.fn(), [A]));
    expect(screen.queryByText(/Todavía no guardas ningún curso/)).toBeNull();
  });

  /** Lo que haría el navegador en dos cuadros: el foco del bloque espera uno. */
  const frames = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  // Cambió por el requisito (T-616, 3b-1): antes, montarse con el ancla en la dirección bastaba para tomar el foco, también al
  // recargar, sin que nadie llegara por la barra. Ahora solo toma el foco al llegar por la barra (la marca de un solo uso que
  // deja «Mi lista»), o si alguien escribe el ancla a mano (`hashchange`).
  it("al recargar con el ancla, sin haber llegado por la barra, no toma el foco", async () => {
    window.history.replaceState(null, "", "/inicio#bloque-lista");
    const { container } = render(page(vi.fn(), [A]));
    await frames();
    expect(container.querySelector("#bloque-lista")).not.toHaveFocus();
    window.history.replaceState(null, "", "/");
  });

  it("al llegar por la barra desde otra pantalla toma el foco al montarse, una sola vez", async () => {
    const user = userEvent.setup();
    // La barra en otra pantalla: se pulsa «Mi lista» y la pantalla se va antes de que el bloque exista.
    const other = render(
      <MyListLink href="/inicio#bloque-lista" className="">
        Mi lista
      </MyListLink>,
    );
    await user.click(screen.getByRole("link", { name: "Mi lista" }));
    other.unmount();
    const first = render(page(vi.fn(), [A]));
    await waitFor(() => expect(first.container.querySelector("#bloque-lista")).toHaveFocus(), { timeout: 3_000 });
    first.unmount();
    // La marca ya se usó: el siguiente montaje no toma el foco.
    const again = render(page(vi.fn(), [A]));
    await frames();
    expect(again.container.querySelector("#bloque-lista")).not.toHaveFocus();
  });

  it("si se escribe el ancla a mano en el inicio, toma el foco; si se quita, no", async () => {
    const { container } = render(page(vi.fn(), [A]));
    const block = container.querySelector<HTMLElement>("#bloque-lista");
    screen.getByRole("button", { name: "Otra cosa" }).focus();
    window.history.replaceState(null, "", "/inicio");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(screen.getByRole("button", { name: "Otra cosa" })).toHaveFocus();
    window.history.replaceState(null, "", "/inicio#bloque-lista");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(block).toHaveFocus(), { timeout: 3_000 });
    window.history.replaceState(null, "", "/");
  });

  it("al quitar, la tarjeta se va y el foco pasa a la siguiente", async () => {
    const { action, sent, answer } = waitingAction();
    const user = userEvent.setup();
    const { rerender } = render(page(action, [A, B, C]));
    await user.click(quitar("Dos"));
    expect(await screen.findByRole("button", { name: "Quitando…" })).toHaveAttribute("aria-disabled", "true");
    // Los demás «Quitar» esperan: inactivos para quien no ve, sin deshabilitarse ni cambiar de nombre.
    expect(quitar("Uno")).toHaveAttribute("aria-disabled", "true");
    expect(quitar("Uno")).toBeEnabled();
    expect(quitar("Uno")).not.toHaveAttribute("aria-busy");
    expect(sent).toEqual(["remove:dos"]);
    await answer({ kind: "removed", slug: "dos", attempt: 1 });
    rerender(page(action, [A, C]));
    await waitFor(() => expect(quitar("Tres")).toHaveFocus());
    expect(quitar("Uno")).not.toHaveAttribute("aria-disabled");
    expect(result()).toHaveTextContent("Quitado de tu lista.");
  });

  it("la última de la fila: el foco pasa a la anterior", async () => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    const { rerender } = render(page(action, [A, B]));
    await user.click(quitar("Dos"));
    await answer({ kind: "removed", slug: "dos", attempt: 1 });
    rerender(page(action, [A]));
    expect(quitar("Uno")).toHaveFocus();
  });

  it("la única: el carrusel se va, el foco pasa al contenido y se dice", async () => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    const { rerender } = render(page(action, [A]));
    await user.click(quitar("Uno"));
    await answer({ kind: "removed", slug: "uno", attempt: 1 });
    rerender(page(action, []));
    expect(screen.queryByRole("region", { name: "Mi lista" })).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveFocus();
    expect(result()).toHaveTextContent("Quitado de tu lista.");
  });

  it("quien se fue a otra cosa mientras esperaba se queda ahí, y se le dice", async () => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    const { rerender } = render(page(action, [A, B]));
    await user.click(quitar("Uno"));
    await user.click(screen.getByRole("button", { name: "Otra cosa" }));
    await answer({ kind: "removed", slug: "uno", attempt: 1 });
    rerender(page(action, [B]));
    expect(screen.getByRole("button", { name: "Otra cosa" })).toHaveFocus();
    expect(result()).toHaveTextContent("Quitado de tu lista.");
  });

  it("volver al bloque antes de la respuesta ya no es haberse ido", async () => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    const { rerender } = render(page(action, [A, B, C]));
    await user.click(quitar("Dos"));
    await user.click(screen.getByRole("button", { name: "Otra cosa" }));
    // Vuelve al carrusel, a otra tarjeta: mientras espera, ese botón no envía nada.
    await user.click(quitar("Uno"));
    await answer({ kind: "removed", slug: "dos", attempt: 1 });
    rerender(page(action, [A, C]));
    await waitFor(() => expect(quitar("Tres")).toHaveFocus());
  });

  it("si no se pudo, la tarjeta se queda, y se ve y se dice", async () => {
    const { action, answer } = waitingAction();
    const user = userEvent.setup();
    render(page(action, [A, B]));
    await user.click(quitar("Uno"));
    await answer({ kind: "unavailable", slug: "uno", attempt: 1 });
    expect(quitar("Uno")).toHaveFocus();
    expect(result()).toHaveTextContent("No pudimos cambiar tu lista.");
    expect(screen.getAllByText("No pudimos cambiar tu lista. Inténtalo de nuevo en un momento.")).toHaveLength(2);
  });
});
