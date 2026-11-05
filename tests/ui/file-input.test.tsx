import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChangeEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { ui } from "@/messages/es/ui";
import { FileInput } from "@/ui/file-input";

// El selector de archivo en español (T-614). El botón del control nativo lo escribe el navegador en
// su idioma («Choose File»): el control se queda, fuera de la vista, y lo que se ve es un botón con
// el texto del catálogo y el nombre de lo elegido.

const file = new File(["x"], "guia.pdf", { type: "application/pdf" });

function setup(props: { disabled?: boolean; onChange?: (event: ChangeEvent<HTMLInputElement>) => void } = {}) {
  const onChange = vi.fn(props.onChange);
  const { container } = render(
    <div>
      <label id="campo-etiqueta" htmlFor="campo">
        Archivo
      </label>
      <FileInput id="campo" labelId="campo-etiqueta" accept=".pdf" aria-describedby="campo-nota" disabled={props.disabled} onChange={onChange} />
      <p id="campo-nota">Solo PDF.</p>
    </div>,
  );
  return { container, onChange, input: screen.getByLabelText<HTMLInputElement>("Archivo") };
}

describe("FileInput", () => {
  it("el control nativo sigue ahí, con el nombre del campo y el del botón que se ve, su nota y lo que admite", () => {
    const { input } = setup();
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".pdf");
    // WCAG 2.5.3: quien lo pide por voz dice lo que lee en el botón.
    expect(input).toHaveAccessibleName(`Archivo ${ui.fileInput.choose}`);
    expect(input).toHaveAccessibleDescription("Solo PDF.");
    expect(input).toHaveClass("sr-only");
  });

  it("el control va antes que el botón: de eso depende que el botón pinte su anillo de foco", () => {
    const { input } = setup();
    const button = screen.getByText(ui.fileInput.choose);
    expect(input.nextElementSibling).toBe(button);
    expect(input).toHaveClass("peer");
    expect(button.className).toContain("peer-focus-visible:outline-focus");
  });

  it("pulsar el botón visible abre el control nativo", () => {
    const { input } = setup();
    const opened = vi.fn();
    input.addEventListener("click", opened);
    fireEvent.click(screen.getByText(ui.fileInput.choose));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  // Con `user-event`: vaciar el control vacía su lista de archivos, como en un navegador (con `fireEvent` no).
  it("si quien lo usa vacía el control al recibirlo, el nombre no se queda a la vista", async () => {
    const { input } = setup({
      onChange: (event) => {
        event.target.value = "";
      },
    });
    await userEvent.setup().upload(input, file);
    expect(screen.getByText(ui.fileInput.none)).toBeInTheDocument();
    expect(screen.queryByText("guia.pdf")).not.toBeInTheDocument();
  });

  it("lo que se ve está en español y lo tiene el catálogo", () => {
    setup();
    expect(screen.getByText(ui.fileInput.choose)).toBeInTheDocument();
    expect(screen.getByText(ui.fileInput.none)).toBeInTheDocument();
  });

  it("el botón visible abre el control nativo y el lector de pantalla no lo lee dos veces", () => {
    setup();
    const button = screen.getByText(ui.fileInput.choose);
    expect(button.tagName).toBe("LABEL");
    expect(button).toHaveAttribute("for", "campo");
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(ui.fileInput.none)).toHaveAttribute("aria-hidden", "true");
  });

  it("al elegir dice el nombre del archivo y avisa a quien lo usa", () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { files: [file] } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByText("guia.pdf")).toBeInTheDocument();
    expect(screen.queryByText(ui.fileInput.none)).not.toBeInTheDocument();
  });

  it("apagado, el control no se elige y el botón se ve apagado", () => {
    const { input } = setup({ disabled: true });
    expect(input).toBeDisabled();
    expect(screen.getByText(ui.fileInput.choose).className).toContain("peer-disabled:text-text-disabled");
  });

  it("pasa las reglas automáticas de accesibilidad", async () => {
    const { container } = setup();
    expect(await a11yViolations(container)).toEqual([]);
  });
});
