import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ui } from "@/messages/es/ui";
import { DataTable } from "@/ui/data-table";
import { Dialog } from "@/ui/dialog";
import { StatTile } from "@/ui/stat-tile";
import { StatusBadge } from "@/ui/status-badge";

import { a11yViolations } from "../setup/a11y";

// Los componentes de datos que llegan con T-605 (diseño, sección 5): la etiqueta de estado, la cifra,
// la tabla de datos y el diálogo. Lo que el DOM simulado no ve (el desplazamiento de la tabla, la hoja
// del diálogo en el teléfono, el foco atrapado de un diálogo modal) se revisa en la muestra.

describe("StatusBadge", () => {
  it("dice el estado con su nombre; el punto de color no se lee", () => {
    const { container } = render(<StatusBadge tone="active">En cierre</StatusBadge>);
    expect(screen.getByText("En cierre")).toBeInTheDocument();
    const dot = container.querySelector("[aria-hidden='true']");
    expect(dot).toHaveClass("bg-accent");
  });

  it.each([
    ["neutral", "bg-text-2"],
    ["active", "bg-accent"],
    ["attention", "bg-warning"],
    ["good", "bg-success"],
    ["bad", "bg-danger"],
  ] as const)("el tono %s pinta su punto", (tone, color) => {
    const { container } = render(<StatusBadge tone={tone}>Estado</StatusBadge>);
    expect(container.querySelector("[aria-hidden='true']")).toHaveClass(color);
  });
});

describe("StatTile", () => {
  it("la cifra con su nombre y su contexto", async () => {
    const { container } = render(<StatTile label="Bote" value="$12,345.00" context="Del ensayo del 2 de noviembre" />);
    expect(screen.getByText("Bote")).toBeInTheDocument();
    expect(screen.getByText("$12,345.00")).toHaveClass("tabular-nums");
    expect(screen.getByText("Del ensayo del 2 de noviembre")).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin dato no pinta un cero: dice que no hay datos", () => {
    render(<StatTile label="Bote" value={null} />);
    expect(screen.getByText(ui.stat.noData)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("una cifra parcial lleva su etiqueta delante y no se ve como la final", () => {
    const { container } = render(<StatTile label="Bote" value="$1.00" tag="Parcial, al 2 de noviembre" />);
    const tag = screen.getByText("Parcial, al 2 de noviembre");
    expect(tag).toHaveClass("text-warning");
    expect(container.firstElementChild).toHaveClass("border-dashed");
    // Se lee primero la etiqueta y después la cifra.
    expect(tag.compareDocumentPosition(screen.getByText("$1.00")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("en tono de atención, con su icono", () => {
    const { container } = render(<StatTile label="Bote sin consumo" value="$1.00" tone="attention" />);
    expect(screen.getByText("$1.00")).toHaveClass("text-warning");
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("DataTable", () => {
  const columns = [
    { key: "teacher", header: "Maestro" },
    { key: "total", header: "Total", numeric: true },
  ];
  const rows = [
    { key: "a", cells: { teacher: "Ana", total: "$10.00" } },
    { key: "b", cells: { teacher: "Beto", total: "$5.00" } },
  ];

  it("es una tabla de verdad: título, encabezados de columna y la primera celda como encabezado de fila", async () => {
    const { container } = render(<DataTable caption="Reparto por maestro" columns={columns} rows={rows} empty="Sin maestros" />);
    const table = screen.getByRole("table", { name: "Reparto por maestro" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.getAttribute("scope"))).toEqual(["col", "col"]);
    expect(within(table).getByRole("rowheader", { name: "Ana" })).toHaveAttribute("scope", "row");
    expect(within(table).getByRole("cell", { name: "$10.00" })).toHaveClass("text-right", "tabular-nums");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("vacía: el encabezado sigue y el estado vacío va dentro, a todo lo ancho", () => {
    render(<DataTable caption="Reparto por maestro" columns={columns} rows={[]} empty="Sin maestros" />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "Sin maestros" })).toHaveAttribute("colspan", "2");
  });

  it("con fila de totales, al pie", () => {
    const { container } = render(
      <DataTable caption="Reparto" columns={columns} rows={rows} empty="Sin maestros" totals={{ teacher: "Total", total: "$15.00" }} />,
    );
    const foot = container.querySelector("tfoot");
    expect(foot).not.toBeNull();
    expect(within(foot as HTMLElement).getByRole("rowheader", { name: "Total" })).toBeInTheDocument();
    expect(within(foot as HTMLElement).getByRole("cell", { name: "$15.00" })).toBeInTheDocument();
  });

  it("las de finanzas se desplazan en horizontal con la primera columna fija", () => {
    const { container } = render(<DataTable caption="Reparto" columns={columns} rows={rows} empty="Sin maestros" scroll />);
    expect(container.firstElementChild).toHaveClass("overflow-x-auto");
    expect(screen.getByRole("rowheader", { name: "Ana" })).toHaveClass("sticky", "left-0");
  });

  it("el título se puede esconder a la vista sin quitárselo a la tabla", () => {
    render(<DataTable caption="Reparto" captionHidden columns={columns} rows={rows} empty="Sin maestros" />);
    expect(screen.getByText("Reparto")).toHaveClass("sr-only");
    expect(screen.getByRole("table", { name: "Reparto" })).toBeInTheDocument();
  });
});

describe("Dialog", () => {
  function dialog(props: { busy?: boolean; irreversible?: boolean } = {}) {
    const cancel = vi.fn((event: React.MouseEvent) => event.preventDefault());
    const view = render(
      <Dialog
        title="¿Cerrar octubre de 2027?"
        irreversible={props.irreversible}
        busy={props.busy}
        cancel={
          <button type="submit" onClick={cancel}>
            Seguir revisando
          </button>
        }
        confirm={<button type="submit">Cerrar el periodo</button>}
      >
        <p>No se puede deshacer.</p>
      </Dialog>,
    );
    return { ...view, cancel };
  }

  it("es un diálogo con su título y sus consecuencias; sin `showModal` (sin JavaScript) no se dice modal", async () => {
    const { container } = dialog();
    const box = screen.getByRole("dialog", { name: "¿Cerrar octubre de 2027?" });
    expect(box).not.toHaveAttribute("aria-modal");
    expect(box).toHaveAccessibleDescription("No se puede deshacer.");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con `showModal` se abre como modal, y entonces se dice modal", async () => {
    const showModal = vi.fn();
    const close = vi.fn();
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
    try {
      dialog();
      expect(showModal).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute("aria-modal", "true"));
    } finally {
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });

  it("cancelar va primero", () => {
    dialog();
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["Seguir revisando", "Cerrar el periodo"]);
  });

  it("Escape cancela: pulsa el botón de cancelar", () => {
    const { cancel } = dialog();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("a media operación, Escape no cancela", () => {
    const { cancel } = dialog({ busy: true });
    const event = new Event("cancel", { cancelable: true });
    fireEvent(screen.getByRole("dialog"), event);
    expect(cancel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("el irreversible dice que no se puede deshacer, también a quien no ve el color", () => {
    dialog({ irreversible: true });
    expect(within(screen.getByRole("dialog")).getByText(ui.dialog.irreversible)).toBeInTheDocument();
  });
});
