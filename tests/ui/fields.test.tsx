import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ui } from "@/messages/es/ui";
import { Checkbox } from "@/ui/checkbox";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { FormErrorSummary } from "@/ui/form-error-summary";
import { PasswordField } from "@/ui/password-field";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";

import { a11yViolations } from "../setup/a11y";

describe("TextField", () => {
  it("la etiqueta está siempre visible y unida a su campo", () => {
    render(<TextField label="Correo" name="email" type="email" autoComplete="email" />);
    const field = screen.getByLabelText("Correo");
    expect(field).toHaveAttribute("type", "email");
    expect(field).toHaveAttribute("name", "email");
    expect(field).toHaveAttribute("autocomplete", "email");
    expect(field).not.toHaveAttribute("placeholder");
  });

  it("lo obligatorio es la norma y no lleva asterisco; lo opcional lo dice", () => {
    render(
      <>
        <TextField label="Correo" name="email" autoComplete="email" />
        <TextField label="País" name="country" autoComplete="country-name" optional />
      </>,
    );
    expect(screen.getByLabelText("Correo")).toHaveAttribute("aria-required", "true");
    expect(screen.queryByText("*")).not.toBeInTheDocument();
    const optional = screen.getByLabelText(`País ${ui.field.optional}`);
    expect(optional).not.toHaveAttribute("aria-required");
  });

  it("la ayuda se anuncia con el campo", () => {
    render(
      <TextField label="Nombre" name="name" autoComplete="name" hint="Así te verán los demás." />,
    );
    expect(screen.getByLabelText("Nombre")).toHaveAccessibleDescription("Así te verán los demás.");
  });

  it("el error marca el campo, dice qué pasó y se anuncia junto con la ayuda", () => {
    render(
      <TextField
        label="Correo"
        name="email"
        autoComplete="email"
        hint="Te escribiremos aquí."
        error="Escribe un correo con arroba, como ana@correo.com."
      />,
    );
    const field = screen.getByLabelText("Correo");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(
      "Te escribiremos aquí. Escribe un correo con arroba, como ana@correo.com.",
    );
  });

  it("sin error no se marca como inválido", () => {
    render(<TextField label="Correo" name="email" autoComplete="email" />);
    expect(screen.getByLabelText("Correo")).not.toHaveAttribute("aria-invalid");
  });

  it("conserva lo escrito y acepta un `id` para que el resumen de errores lo enlace", () => {
    render(<TextField id="campo-correo" label="Correo" name="email" autoComplete="email" defaultValue="ana@correo.com" />);
    const field = screen.getByLabelText("Correo");
    expect(field).toHaveValue("ana@correo.com");
    expect(field).toHaveAttribute("id", "campo-correo");
  });

  it("no tiene faltas de accesibilidad, con ayuda, error u opcional", async () => {
    const { container } = render(
      <form>
        <TextField label="Correo" name="email" type="email" autoComplete="email" hint="Te escribiremos aquí." />
        <TextField label="Nombre" name="name" autoComplete="name" error="Escribe tu nombre." />
        <TextField label="País" name="country" autoComplete="country-name" optional />
      </form>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("PasswordField", () => {
  it("empieza oculta y se puede mostrar y volver a ocultar", async () => {
    const user = userEvent.setup();
    render(<PasswordField label="Contraseña" name="password" autoComplete="current-password" />);
    const field = screen.getByLabelText("Contraseña");
    expect(field).toHaveAttribute("type", "password");

    await user.click(screen.getByRole("button", { name: ui.password.showLabel }));
    expect(field).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: ui.password.hideLabel })).toHaveTextContent(ui.password.hide);

    await user.click(screen.getByRole("button", { name: ui.password.hideLabel }));
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: ui.password.showLabel })).toHaveTextContent(ui.password.show);
  });

  it("nunca bloquea el pegado ni el llenado automático", async () => {
    const user = userEvent.setup();
    render(<PasswordField label="Contraseña" name="password" autoComplete="current-password" />);
    const field = screen.getByLabelText("Contraseña");
    await user.click(field);
    await user.paste("una-clave-larga-del-gestor");
    expect(field).toHaveValue("una-clave-larga-del-gestor");
    expect(field).toHaveAttribute("autocomplete", "current-password");
  });

  it("mostrar la contraseña no envía el formulario", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordField label="Contraseña" name="password" autoComplete="new-password" />
      </form>,
    );
    await user.click(screen.getByRole("button", { name: ui.password.showLabel }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("al crearla, las reglas están a la vista y se anuncian con el campo", () => {
    render(
      <PasswordField
        label="Contraseña"
        name="password"
        autoComplete="new-password"
        rules={<ul><li>8 caracteres o más</li></ul>}
      />,
    );
    expect(screen.getByLabelText("Contraseña")).toHaveAccessibleDescription("8 caracteres o más");
    expect(screen.getByText("8 caracteres o más")).toBeVisible();
  });

  it("el error se enlaza igual que en un campo de texto", () => {
    render(
      <PasswordField label="Contraseña" name="password" autoComplete="current-password" error="Escribe tu contraseña." />,
    );
    const field = screen.getByLabelText("Contraseña");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Escribe tu contraseña.");
  });

  it("no tiene faltas de accesibilidad", async () => {
    const { container } = render(
      <form>
        <PasswordField label="Contraseña" name="password" autoComplete="new-password" error="Le falta un número." />
      </form>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("Checkbox", () => {
  it("toda la fila responde: tocar el texto la marca", async () => {
    const user = userEvent.setup();
    render(<Checkbox name="news" label="Quiero recibir novedades por correo." />);
    const box = screen.getByRole("checkbox", { name: "Quiero recibir novedades por correo." });
    expect(box).not.toBeChecked();
    await user.click(screen.getByText("Quiero recibir novedades por correo."));
    expect(box).toBeChecked();
  });

  it("se marca con teclado", async () => {
    const user = userEvent.setup();
    render(<Checkbox name="news" label="Quiero recibir novedades por correo." />);
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("la fila mide al menos 44 px", () => {
    render(<Checkbox name="news" label="Quiero recibir novedades por correo." />);
    expect(screen.getByText("Quiero recibir novedades por correo.").closest("label")).toHaveClass("min-h-touch");
  });

  it("el error se enlaza a la casilla", () => {
    render(<Checkbox name="age" label="Tengo 18 años o más." error="Para registrarte hace falta que lo confirmes." />);
    const box = screen.getByRole("checkbox");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription("Para registrarte hace falta que lo confirmes.");
  });
});

describe("ConsentCheckbox", () => {
  const terms = (
    <>
      Acepto los{" "}
      <TextLink href="/terminos" external>
        términos y condiciones
      </TextLink>
      .
    </>
  );

  it("nunca viene marcada", () => {
    render(<ConsentCheckbox name="terms" label={terms} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    // @ts-expect-error un consentimiento no se puede marcar por la persona
    render(<ConsentCheckbox name="x" label="x" defaultChecked />);
  });

  it("el enlace al documento abre en otra pestaña y no marca la casilla", () => {
    render(<ConsentCheckbox name="terms" label={terms} />);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("sin aceptar, el error dice qué falta, junto a la casilla", () => {
    render(<ConsentCheckbox name="terms" label={terms} invalid />);
    const box = screen.getByRole("checkbox");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription(ui.consent.required);
  });

  it("la explicada es un grupo con su título, su explicación y la casilla al final", () => {
    render(
      <ConsentCheckbox
        variant="explained"
        name="history"
        title="Tu historial de cursos"
        description={<p>Guardamos qué lecciones viste para que puedas seguir donde te quedaste.</p>}
        label="Acepto que se guarde mi historial."
      />,
    );
    const group = screen.getByRole("group", { name: "Tu historial de cursos" });
    expect(within(group).getByText(/Guardamos qué lecciones viste/)).toBeVisible();
    const box = within(group).getByRole("checkbox", { name: "Acepto que se guarde mi historial." });
    expect(group.lastElementChild).toContainElement(box);
  });

  it("no tiene faltas de accesibilidad, sencilla o explicada", async () => {
    const { container } = render(
      <form>
        <ConsentCheckbox name="terms" label={terms} invalid />
        <ConsentCheckbox
          variant="explained"
          name="history"
          title="Tu historial de cursos"
          description={<p>Guardamos qué lecciones viste.</p>}
          label="Acepto que se guarde mi historial."
        />
      </form>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("FormErrorSummary", () => {
  const errors = [
    { fieldId: "campo-correo", message: "Escribe un correo con arroba." },
    { fieldId: "campo-clave", message: "Escribe tu contraseña." },
  ];

  it("sin errores no pinta nada", () => {
    const { container } = render(<FormErrorSummary errors={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("dice cuántos datos hay por corregir, en singular y en plural", () => {
    const { rerender } = render(<FormErrorSummary errors={errors.slice(0, 1)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Hay 1 dato por corregir");
    rerender(<FormErrorSummary errors={errors} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Hay 2 datos por corregir");
  });

  it("recibe el foco al aparecer, para que se lea antes que el formulario", () => {
    render(<FormErrorSummary errors={errors} />);
    expect(screen.getByRole("alert")).toHaveFocus();
  });

  // Una pantalla suele armar el arreglo de errores en cada dibujado. Si el foco dependiera
  // de que el arreglo sea «otro», saltaría al resumen con cada tecla y no se podría
  // avanzar por el formulario.
  it("no vuelve a tomar el foco si los errores son los mismos, aunque el arreglo sea otro", async () => {
    const user = userEvent.setup();
    const view = (list: typeof errors) => (
      <>
        <FormErrorSummary errors={list} />
        <TextField id="campo-correo" label="Correo" name="email" autoComplete="email" />
      </>
    );
    const { rerender } = render(view(errors));
    const field = screen.getByLabelText("Correo");
    await user.click(field);
    expect(field).toHaveFocus();

    rerender(view(errors.map((error) => ({ ...error }))));
    expect(field).toHaveFocus();
  });

  it("vuelve a tomar el foco cuando llega una tanda distinta de errores", async () => {
    const user = userEvent.setup();
    const view = (list: typeof errors) => (
      <>
        <FormErrorSummary errors={list} />
        <TextField id="campo-correo" label="Correo" name="email" autoComplete="email" />
      </>
    );
    const { rerender } = render(view(errors));
    await user.click(screen.getByLabelText("Correo"));

    rerender(view([{ fieldId: "campo-correo", message: "Ese correo ya tiene cuenta." }]));
    expect(screen.getByRole("alert")).toHaveFocus();
  });

  it("cada error es un enlace que lleva el foco a su campo", async () => {
    const user = userEvent.setup();
    render(
      <>
        <FormErrorSummary errors={errors} />
        <TextField id="campo-correo" label="Correo" name="email" autoComplete="email" />
        <PasswordField id="campo-clave" label="Contraseña" name="password" autoComplete="current-password" />
      </>,
    );
    const link = screen.getByRole("link", { name: "Escribe tu contraseña." });
    expect(link).toHaveAttribute("href", "#campo-clave");
    await user.click(link);
    expect(screen.getByLabelText("Contraseña")).toHaveFocus();
  });

  it("no tiene faltas de accesibilidad", async () => {
    const { container } = render(<FormErrorSummary errors={errors} />);
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("arreglos de la revisión independiente", () => {
  // RF-108: un consentimiento vale si la persona supo qué aceptaba. Quien llega a la
  // casilla con el tabulador y un lector de pantalla tiene que oír la explicación.
  it("la casilla de un consentimiento explicado lee qué se guarda y para qué", () => {
    render(
      <ConsentCheckbox
        variant="explained"
        name="history"
        title="Tu historial de cursos"
        description={<p>Guardamos qué lecciones viste para que sigas donde te quedaste.</p>}
        label="Acepto que se guarde mi historial."
      />,
    );
    expect(screen.getByRole("checkbox")).toHaveAccessibleDescription(
      "Guardamos qué lecciones viste para que sigas donde te quedaste.",
    );
  });

  it("y si además falta aceptarlo, lee la explicación y luego el error", () => {
    render(
      <ConsentCheckbox
        variant="explained"
        name="history"
        invalid
        title="Tu historial de cursos"
        description={<p>Guardamos qué lecciones viste.</p>}
        label="Acepto que se guarde mi historial."
      />,
    );
    expect(screen.getByRole("checkbox")).toHaveAccessibleDescription(
      `Guardamos qué lecciones viste. ${ui.consent.required}`,
    );
  });

  // Un campo de texto con la contraseña a la vista puede acabar en el historial de
  // formularios del navegador, y el gestor de contraseñas puede no ofrecer guardarla.
  it("la contraseña vuelve a ocultarse al enviar el formulario, aunque estuviera a la vista", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordField label="Contraseña" name="password" autoComplete="current-password" />
        <button type="submit">Entrar</button>
      </form>,
    );
    const field = screen.getByLabelText("Contraseña");
    await user.click(screen.getByRole("button", { name: ui.password.showLabel }));
    expect(field).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(field).toHaveAttribute("type", "password");
  });
});
