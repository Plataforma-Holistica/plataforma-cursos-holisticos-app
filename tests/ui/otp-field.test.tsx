import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { OTPField } from "@/ui/otp-field";

import { a11yViolations } from "../setup/a11y";

// El campo del código del segundo factor (diseño, sección 5.3; PA-12): un solo campo, no
// seis cajitas. Se puede pegar el código completo y el navegador puede llenarlo.

describe("OTPField", () => {
  it("es un solo campo de texto, con teclado numérico y llenado automático de códigos", () => {
    render(<OTPField label="Código" name="code" />);
    const field = screen.getByLabelText("Código");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(field).toHaveAttribute("type", "text");
    expect(field).toHaveAttribute("inputmode", "numeric");
    expect(field).toHaveAttribute("autocomplete", "one-time-code");
    expect(field).toHaveAttribute("name", "code");
    expect(field).toHaveAttribute("aria-required", "true");
  });

  it("no corta lo que se pega: las aplicaciones muestran el código partido en dos", async () => {
    render(<OTPField label="Código" name="code" />);
    const field = screen.getByLabelText("Código");
    // Sin tope de largo ni patrón: «123 456» son siete caracteres, y los revisa el servidor.
    expect(field).not.toHaveAttribute("maxlength");
    expect(field).not.toHaveAttribute("pattern");
    await userEvent.click(field);
    await userEvent.paste("123 456");
    expect(field).toHaveValue("123 456");
  });

  it("nunca trae un código ya escrito: un código no se devuelve a la pantalla", () => {
    render(<OTPField label="Código" name="code" />);
    expect(screen.getByLabelText("Código")).toHaveValue("");
    expect(screen.getByLabelText("Código")).not.toHaveAttribute("value");
  });

  it("la ayuda y el error se anuncian con el campo, y el error lo marca", () => {
    render(<OTPField id="campo-codigo" label="Código" name="code" hint="Seis dígitos." error="Ese código no coincide." />);
    const field = screen.getByLabelText("Código");
    expect(field).toHaveAttribute("id", "campo-codigo");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Seis dígitos. Ese código no coincide.");
  });

  it("sin error no queda marcado", () => {
    render(<OTPField label="Código" name="code" />);
    expect(screen.getByLabelText("Código")).not.toHaveAttribute("aria-invalid");
  });

  it("pasa las reglas automáticas de accesibilidad, en reposo y con error", async () => {
    const { container } = render(
      <form>
        <OTPField label="Código" name="code" hint="Seis dígitos." />
        <OTPField label="Otro código" name="other" error="Ese código no coincide." />
      </form>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});
