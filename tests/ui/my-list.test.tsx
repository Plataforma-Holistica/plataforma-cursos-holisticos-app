import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MyListBlock, type ListCourse } from "@/app/_catalog/my-list/my-list-block";
import type { ListState } from "@/app/_catalog/my-list/outcomes";
import { SaveCourseButton } from "@/app/_catalog/my-list/save-button";
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
    expect(pending).toHaveFocus();
    await user.click(pending);
    expect(sent).toEqual(["save:respirar"]);

    await answer({ kind: "saved", slug: "respirar", attempt: 1 });
    // La página se vuelve a pedir y dice que ya está guardado.
    rerender(button({ action, saved: true }));
    const remove = screen.getByRole("button", { name: "Quitar de mi lista: Respirar" });
    expect(remove).toHaveFocus();
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
    expect(quitar("Tres")).toHaveFocus();
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
    expect(quitar("Tres")).toHaveFocus();
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
