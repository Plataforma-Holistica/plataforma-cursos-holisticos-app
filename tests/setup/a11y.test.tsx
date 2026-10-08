import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "./a11y";

// La herramienta también se prueba: si las reglas de accesibilidad dejaran de encontrar
// faltas, todas las pruebas de componentes pasarían sin demostrar nada.
describe("preparación de las pruebas de componentes", () => {
  it("hay un DOM, y el teclado simulado mueve el foco", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Uno</button>
        <button type="button">Dos</button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Uno" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Dos" })).toHaveFocus();
  });

  it("un campo con su etiqueta no tiene faltas", async () => {
    const { container } = render(
      <>
        <label htmlFor="correo">Correo</label>
        <input id="correo" type="email" />
      </>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("encuentra un campo sin etiqueta, una imagen sin texto y un botón sin nombre", async () => {
    const { container } = render(
      <>
        <input type="text" />
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- la falta es a propósito */}
        <img src="x.png" />
        <button type="button" />
      </>,
    );
    const found = (await a11yViolations(container)).map((violation) => violation.split(":")[0]);
    expect(found).toEqual(expect.arrayContaining(["label", "image-alt", "button-name"]));
  });

  it("cada prueba empieza con el documento limpio", () => {
    expect(document.body).toBeEmptyDOMElement();
  });
});
