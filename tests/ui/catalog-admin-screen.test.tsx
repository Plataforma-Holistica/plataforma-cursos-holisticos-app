import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La pantalla de las prácticas y los niveles (PA-67). Las acciones de servidor son la
// frontera con el servicio: aquí se cambian por lo que contestarían, para ver qué pinta cada
// bloque con cada respuesta, qué manda cada botón y a dónde va el foco. Lo que hacen de
// verdad lo prueban sus tablas y el extremo a extremo.
const actions = vi.hoisted(() => ({
  catalogCodeAction: vi.fn(),
  practicesAction: vi.fn(),
  levelsAction: vi.fn(),
}));
vi.mock("@/app/admin/_practicas/actions", () => actions);

import type { CatalogState } from "@/app/admin/_practicas/outcomes";
import { catalogView } from "@/app/admin/_practicas/rows";
import { CatalogScreen } from "@/app/admin/_practicas/screen";
import type { CatalogItem, CatalogLists, Practice } from "@/services/catalog/catalog";

import { a11yViolations } from "../setup/a11y";

beforeEach(() => vi.clearAllMocks());

const YOGA = "b0000000-0000-4000-8000-000000000001";
const REIKI = "b0000000-0000-4000-8000-000000000002";
const TAICHI = "b0000000-0000-4000-8000-000000000003";
const BASIC = "c0000000-0000-4000-8000-000000000001";

const practice = (id: string, name: string, position: number, coverTone: number, isActive = true): Practice => ({
  id,
  slug: name.toLowerCase(),
  name,
  position,
  isActive,
  coverTone,
});
const level = (id: string, name: string, position: number): CatalogItem => ({ id, slug: name.toLowerCase(), name, position, isActive: true });
const listsOf = (over: Partial<CatalogLists> = {}): CatalogLists => ({
  freshCode: true,
  practices: [practice(YOGA, "Yoga", 1, 1), practice(REIKI, "Reiki", 2, 2, false), practice(TAICHI, "Tai chi", 3, 3)],
  levels: [level(BASIC, "Básico", 1)],
  ...over,
});

const formOf = (action: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries(action.mock.calls[call]?.[1] as FormData);
const blockOf = (title: string) => {
  const block = screen.getByRole("heading", { level: 2, name: title }).closest("section");
  if (block === null) throw new Error(`Falta el bloque «${title}».`);
  return within(block);
};
const show = (lists: CatalogLists = listsOf()) => ({ user: userEvent.setup(), ...render(<CatalogScreen view={catalogView(lists)} />) });

describe("la pantalla, en reposo", () => {
  it("con el código reciente: las dos listas con sus cambios, y sin pedir el código", async () => {
    const { container } = show();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Prácticas y niveles");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Prácticas", "Niveles"]);
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva")).toBeVisible();
    expect(blockOf("Niveles").getByLabelText("Nombre del nivel nuevo")).toBeVisible();
    expect(screen.getByRole("link", { name: "Ir al inicio de administración" })).toHaveAttribute("href", "/admin");
    // Sin diálogo ni arrastre (decisiones del 2026-10-14).
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin el código reciente: arriba se pide, las listas se ven y ningún cambio se ofrece", async () => {
    const { container } = show(listsOf({ freshCode: false }));
    expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent("Tu código");
    expect(screen.getAllByRole("button")).toEqual([screen.getByRole("button", { name: "Comprobar" })]);
    expect(screen.queryByLabelText("Nombre de la práctica nueva")).not.toBeInTheDocument();
    expect(blockOf("Prácticas").getByText("Yoga")).toBeVisible();
    expect(screen.getAllByText("Escribe tu código, al inicio de esta página, para poder hacer cambios.")).toHaveLength(2);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("vacías: lo dicen, sin una lista vacía", () => {
    show(listsOf({ practices: [], levels: [] }));
    expect(blockOf("Prácticas").getByText("Todavía no hay prácticas.")).toBeVisible();
    expect(blockOf("Niveles").getByText("Todavía no hay niveles.")).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("cada fila: su tono en palabras, la marca de desactivada, y los botones que la base aceptaría", () => {
    show();
    const practices = blockOf("Prácticas");
    expect(practices.getByText("Tono de portada: arcilla")).toBeVisible();
    expect(practices.getByText("Desactivada")).toBeVisible();
    // Yoga es la primera activa: no sube. Tai chi, la última: no baja. Reiki, desactivada.
    expect(practices.queryByRole("button", { name: "Subir «Yoga»" })).not.toBeInTheDocument();
    expect(practices.getByRole("button", { name: "Bajar «Yoga»" })).toHaveValue(`down:${YOGA}:1`);
    expect(practices.getByRole("button", { name: "Subir «Tai chi»" })).toHaveValue(`up:${TAICHI}:3`);
    expect(practices.queryByRole("button", { name: "Bajar «Tai chi»" })).not.toBeInTheDocument();
    expect(practices.getByRole("button", { name: "Reactivar «Reiki»" })).toHaveValue(`reactivate:${REIKI}`);
    expect(practices.queryByRole("button", { name: "Renombrar «Reiki»" })).not.toBeInTheDocument();
    expect(practices.getByRole("button", { name: "Desactivar «Yoga»" })).toHaveValue(`deactivate:${YOGA}`);
  });
});

describe("agregar", () => {
  it("manda el nombre; hecho, lo dice, vacía el campo y deja ahí el foco para seguir", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "done", what: "added", id: YOGA, name: "Meditación", direction: null, attempt: 1 } satisfies CatalogState);
    const { user } = show();
    const field = blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva");
    await user.type(field, "Meditación");
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Agregar práctica" }));
    expect(formOf(actions.practicesAction)).toEqual({ do: "add", name: "Meditación" });
    // A la vista, y en la región viva aparte: el aviso a la vista no es una región viva.
    const said = await screen.findAllByText("Agregada: «Meditación».");
    expect(said.map((each) => each.getAttribute("role"))).toEqual([null, "status"]);
    expect(said[0]).toBeVisible();
    // El foco llega después de pintar: se espera, como lo espera quien usa el teclado.
    await waitFor(() => {
      const again = blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva");
      expect(again).toHaveValue("");
      expect(again).toHaveFocus();
    });
  });

  it("con Enter en el campo también agrega", async () => {
    actions.levelsAction.mockResolvedValue({ kind: "idle" } satisfies CatalogState);
    const { user } = show();
    await user.type(blockOf("Niveles").getByLabelText("Nombre del nivel nuevo"), "Medio{Enter}");
    expect(formOf(actions.levelsAction)).toEqual({ do: "add", name: "Medio" });
  });

  it("con un error, lo escrito vuelve y el resumen toma el foco", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "add_invalid", name: "yoga", problem: "duplicate", attempt: 1 } satisfies CatalogState);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Agregar práctica" }));
    const message = "Ya existe una práctica con ese nombre. Puede estar desactivada: búscala en la lista.";
    const link = await screen.findByRole("link", { name: message });
    await waitFor(() => expect(link.closest("[tabindex]")).toHaveFocus());
    expect(blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva")).toHaveValue("yoga");
  });

  it("lo que se estaba escribiendo sin enviar se queda cuando se pulsa otro botón del bloque", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "done", what: "deactivated", id: YOGA, name: null, direction: null, attempt: 1 } satisfies CatalogState);
    const { user } = show();
    await user.type(blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva"), "Reiki");
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Desactivar «Yoga»" }));
    expect(formOf(actions.practicesAction)).toEqual({ do: `deactivate:${YOGA}` });
    expect(await screen.findByText(/^Desactivada\. Ya no se ofrece/)).toBeVisible();
    expect(blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva")).toHaveValue("Reiki");
  });

  it("el nombre de una desactivada: lo dice, y ofrece reactivarla con su id", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "inactive_duplicate", id: REIKI, name: "reiki", attempt: 1 } satisfies CatalogState);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Agregar práctica" }));
    expect(await screen.findByText("«reiki» ya existe, desactivada. Puedes reactivarla: vuelve a su lugar en la lista.")).toBeVisible();
    expect(blockOf("Prácticas").getByRole("button", { name: "Reactivar «reiki»" })).toHaveValue(`reactivate:${REIKI}`);
  });
});

describe("renombrar", () => {
  const opened: CatalogState = { kind: "renaming", id: TAICHI, name: null, problem: null, attempt: 1 };

  it("abre la fila con el nombre de ahora, el foco en el campo, y no pinta ningún otro botón en la lista", async () => {
    actions.practicesAction.mockResolvedValue(opened);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Renombrar «Tai chi»" }));
    expect(formOf(actions.practicesAction)).toEqual({ do: `rename:${TAICHI}` });
    const field = await screen.findByLabelText("Nombre nuevo de «Tai chi»");
    expect(field).toHaveValue("Tai chi");
    await waitFor(() => expect(field).toHaveFocus());
    const list = field.closest("form");
    if (list === null) throw new Error("El campo no está en un formulario.");
    expect(within(list).getAllByRole("button").map((button) => (button as HTMLButtonElement).value)).toEqual([`save:${TAICHI}`, "cancel"]);
  });

  it("Enter en el campo guarda esa fila: no envía otro botón de la lista", async () => {
    actions.practicesAction.mockResolvedValueOnce(opened).mockResolvedValueOnce({
      kind: "done",
      what: "renamed",
      id: TAICHI,
      name: null,
      direction: null,
      attempt: 2,
    } satisfies CatalogState);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Renombrar «Tai chi»" }));
    const field = await screen.findByLabelText("Nombre nuevo de «Tai chi»");
    await user.clear(field);
    await user.type(field, "Tai chi chuan{Enter}");
    expect(formOf(actions.practicesAction, 1)).toEqual({ do: `save:${TAICHI}`, name: "Tai chi chuan" });
    expect(await screen.findByText("Nombre guardado.")).toBeVisible();
  });

  it("con un error, la fila sigue abierta con lo escrito y el error en el campo", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "renaming", id: TAICHI, name: "yoga", problem: "duplicate", attempt: 2 } satisfies CatalogState);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Renombrar «Tai chi»" }));
    expect(await screen.findByLabelText("Nombre nuevo de «Tai chi»")).toHaveValue("yoga");
    expect(screen.getByRole("link", { name: "Ya existe una práctica con ese nombre. Puede estar desactivada: búscala en la lista." })).toBeVisible();
  });

  it("si la página deja de leer un código reciente, la fila abierta se cierra: lo decide el dato de la página", async () => {
    actions.practicesAction.mockResolvedValue(opened);
    const { user, rerender } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Renombrar «Tai chi»" }));
    expect(await screen.findByLabelText("Nombre nuevo de «Tai chi»")).toBeVisible();
    rerender(<CatalogScreen view={catalogView(listsOf({ freshCode: false }))} />);
    expect(screen.queryByLabelText("Nombre nuevo de «Tai chi»")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar" })).not.toBeInTheDocument();
  });
});

describe("el código que dejó de ser reciente", () => {
  const NEEDS_CODE = "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio.";

  it("se dice en el bloque mientras la página lee que hace falta, y deja de decirse cuando ya lo dio", async () => {
    actions.levelsAction.mockResolvedValue({ kind: "failed", reason: "needs_code", name: null, attempt: 1 } satisfies CatalogState);
    const { user, rerender } = show();
    await user.click(blockOf("Niveles").getByRole("button", { name: "Desactivar «Básico»" }));
    // La acción vuelve a pedir la página, que ahora lee que el código no es reciente.
    rerender(<CatalogScreen view={catalogView(listsOf({ freshCode: false }))} />);
    expect(await blockOf("Niveles").findByText(NEEDS_CODE)).toBeVisible();
    // Dio su código: la página vuelve a leer uno reciente, y el aviso ya no es cierto.
    rerender(<CatalogScreen view={catalogView(listsOf())} />);
    expect(screen.queryByText(NEEDS_CODE)).not.toBeInTheDocument();
  });
  it("lo que se quiso agregar no se pierde: vuelve en el campo cuando ya lo dio", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "failed", reason: "needs_code", name: "Reiki", attempt: 1 } satisfies CatalogState);
    const { user, rerender } = show();
    await user.type(blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva"), "Reiki");
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Agregar práctica" }));
    rerender(<CatalogScreen view={catalogView(listsOf({ freshCode: false }))} />);
    expect(await blockOf("Prácticas").findByText(NEEDS_CODE)).toBeVisible();
    expect(screen.queryByLabelText("Nombre de la práctica nueva")).not.toBeInTheDocument();
    rerender(<CatalogScreen view={catalogView(listsOf())} />);
    expect(blockOf("Prácticas").getByLabelText("Nombre de la práctica nueva")).toHaveValue("Reiki");
  });
});

describe("ordenar, desactivar y reactivar", () => {
  it("subir: el foco vuelve al mismo botón de la fila, y se dice a dónde quedó", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "done", what: "moved", id: TAICHI, name: null, direction: "up", attempt: 1 } satisfies CatalogState);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Subir «Tai chi»" }));
    expect(formOf(actions.practicesAction)).toEqual({ do: `up:${TAICHI}:3` });
    // La vista no cambió en esta prueba: Tai chi sigue segunda de dos activas.
    expect((await screen.findAllByText("«Tai chi» quedó en el lugar 2 de 2."))[0]).toBeVisible();
    await waitFor(() => expect(blockOf("Prácticas").getByRole("button", { name: "Subir «Tai chi»" })).toHaveFocus());
  });

  it("si el botón del sentido pulsado ya no está, el foco va al del otro sentido", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "done", what: "moved", id: YOGA, name: null, direction: "up", attempt: 1 } satisfies CatalogState);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Bajar «Yoga»" }));
    const down = await blockOf("Prácticas").findByRole("button", { name: "Bajar «Yoga»" });
    await waitFor(() => expect(down).toHaveFocus());
  });

  it("desactivar no pregunta: el botón ya lo hace, y el resultado toma el foco", async () => {
    actions.practicesAction.mockResolvedValue({ kind: "done", what: "deactivated", id: YOGA, name: null, direction: null, attempt: 1 } satisfies CatalogState);
    const { user } = show();
    await user.click(blockOf("Prácticas").getByRole("button", { name: "Desactivar «Yoga»" }));
    expect(formOf(actions.practicesAction)).toEqual({ do: `deactivate:${YOGA}` });
    const message = await screen.findByText(/^Desactivada\. Ya no se ofrece/);
    await waitFor(() => expect(message.closest("[tabindex]")).toHaveFocus());
  });

  it.each([
    [{ kind: "failed", reason: "list_changed", name: null, attempt: 1 }, "La lista cambió mientras la veías. Esta es la de ahora: revisa y repite si hace falta."],
    [{ kind: "failed", reason: "unknown", name: null, attempt: 1 }, "No supimos si el cambio se hizo. Revisa la lista antes de intentarlo otra vez."],
    [{ kind: "unchanged", attempt: 1 }, "No había nada que cambiar."],
  ] satisfies [CatalogState, string][])("lo que contestó se dice en el bloque: %j", async (state, message) => {
    actions.levelsAction.mockResolvedValue(state);
    const { user } = show();
    await user.click(blockOf("Niveles").getByRole("button", { name: "Desactivar «Básico»" }));
    expect(await blockOf("Niveles").findByText(message)).toBeVisible();
  });
});
