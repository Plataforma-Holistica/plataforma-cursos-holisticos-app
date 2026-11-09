import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CodeBlock, type CodeBlockProps } from "@/app/admin/_lib/code-block";

// «Tu código», el bloque compartido de administración. Lo que una acción necesita de la pantalla viaja en campos ocultos
// del formulario, nunca atado a la acción con `bind` (sin JavaScript, atada, la página no se volvía a pintar).

const props: CodeBlockProps = {
  blockId: "bloque-prueba-codigo",
  titleId: "titulo-prueba-codigo",
  fieldId: "campo-prueba-codigo",
  body: "Para cambiar algo aquí.",
  notAvailable: "No hay arreglo.",
  state: { kind: "idle" },
  action: () => undefined,
  pending: false,
};

const hiddenOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLInputElement>('form input[type="hidden"]')).map((input) => [input.name, input.value]);

describe("CodeBlock", () => {
  it("sin campos ocultos no pinta ninguno: las pantallas que no los usan no cambian", () => {
    const { container } = render(<CodeBlock {...props} />);
    expect(hiddenOf(container)).toEqual([]);
  });

  it("pinta los campos ocultos que le da la pantalla, dentro del formulario del código", () => {
    const { container } = render(<CodeBlock {...props} hidden={{ period: "202710", page: "close" }} />);
    expect(hiddenOf(container)).toEqual([
      ["period", "202710"],
      ["page", "close"],
    ]);
  });

  it("un campo oculto no puede llamarse como el del código", () => {
    expect(() => render(<CodeBlock {...props} hidden={{ code: "123456" }} />)).toThrow();
  });
});
