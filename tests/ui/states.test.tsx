import { render, screen, within } from "@testing-library/react";
import { SearchX } from "lucide";
import { describe, expect, it } from "vitest";

import { terms } from "@/messages/es/terms";
import { ui } from "@/messages/es/ui";
import { Button } from "@/ui/button";
import { Disclaimer } from "@/ui/disclaimer";
import { FullScreenState } from "@/ui/full-screen-state";
import { InlineAlert } from "@/ui/inline-alert";
import { TextLink } from "@/ui/text-link";

import { a11yViolations } from "../setup/a11y";

describe("InlineAlert", () => {
  // Una región viva solo anuncia lo que cambia después de que existe. Una nota fija no
  // necesita serlo, y un error que ya viene pintado desde el servidor no se anuncia por
  // llevar `role="alert"`: por eso es una opción, apagada.
  it("por omisión es una nota fija: no interrumpe ni se anuncia sola", () => {
    render(<InlineAlert tone="danger">El correo o la contraseña no coinciden.</InlineAlert>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("El correo o la contraseña no coinciden.")).toBeVisible();
  });

  it("con `live`, un error interrumpe: es una alerta", () => {
    render(
      <InlineAlert tone="danger" live>
        El correo o la contraseña no coinciden.
      </InlineAlert>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("El correo o la contraseña no coinciden.");
  });

  it.each(["neutral", "success", "warning"] as const)(
    "con `live`, el tono %s avisa sin interrumpir",
    (tone) => {
      render(
        <InlineAlert tone={tone} live>
          Te mandamos un correo.
        </InlineAlert>,
      );
      expect(screen.getByRole("status")).toHaveTextContent("Te mandamos un correo.");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each(["neutral", "success", "warning", "danger"] as const)(
    "el tono %s no depende del color: lleva icono y su nombre",
    (tone) => {
      const { container } = render(<InlineAlert tone={tone}>Mensaje.</InlineAlert>);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByText(ui.alert[tone])).toHaveClass("sr-only");
    },
  );

  it("puede llevar un botón", () => {
    const { container } = render(
      <InlineAlert tone="warning" action={<Button variant="text">Reenviar el correo</Button>}>
        Todavía no verificas tu correo.
      </InlineAlert>,
    );
    expect(
      within(container).getByRole("button", { name: "Reenviar el correo" }),
    ).toBeVisible();
  });

  it("los cuatro tonos no tienen faltas de accesibilidad, fijos y vivos", async () => {
    const { container } = render(
      <>
        <InlineAlert tone="neutral">Nota.</InlineAlert>
        <InlineAlert tone="success">Guardado.</InlineAlert>
        <InlineAlert tone="warning" live>
          Revisa tu correo.
        </InlineAlert>
        <InlineAlert tone="danger" live>
          No se pudo guardar.
        </InlineAlert>
      </>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("Disclaimer", () => {
  it("dice que la Plataforma es educativa, con su nombre del bloque de términos", () => {
    render(<Disclaimer />);
    expect(
      screen.getByText(`${terms.Plataforma} es educativa. No sustituye la atención médica ni psicológica profesional.`),
    ).toBeVisible();
  });

  it("en el registro va más grande y más claro que en el pie", () => {
    const { rerender } = render(<Disclaimer />);
    expect(screen.getByText(/es educativa/).closest("p")).toHaveClass("text-caption", "text-text-3");
    rerender(<Disclaimer variant="signUp" />);
    expect(screen.getByText(/es educativa/).closest("p")).toHaveClass("text-body-s", "text-text-2");
  });

  it("no tiene faltas de accesibilidad", async () => {
    const { container } = render(<Disclaimer />);
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("FullScreenState", () => {
  const state = (
    <FullScreenState
      icon={SearchX}
      title="No encontramos esa página"
      primaryAction={<Button href="/">Ir al inicio</Button>}
      secondaryActions={<Button href="/cursos" variant="secondary">Explorar cursos</Button>}
      help={<TextLink href="/ayuda">Pedir ayuda</TextLink>}
      reference="Código de referencia: abc123"
    >
      <p>Puede que la dirección esté mal o que ya no esté disponible.</p>
    </FullScreenState>
  );

  it("el título es el encabezado de la pantalla y recibe el foco al aparecer", () => {
    render(state);
    const title = screen.getByRole("heading", { level: 1, name: "No encontramos esa página" });
    expect(title).toHaveFocus();
    expect(title).toHaveAttribute("tabindex", "-1");
  });

  // Cuando es toda la pantalla, el título toma el foco. Dentro de otra pantalla (una
  // muestra, una sección) no debe robárselo a lo que la persona estaba haciendo.
  it("no toma el foco si se le pide que no", () => {
    render(
      <FullScreenState icon={SearchX} title="No encontramos esa página" primaryAction={null} focusTitle={false}>
        <p>Texto.</p>
      </FullScreenState>,
    );
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveFocus();
  });

  it("el título no pierde su anillo de foco: quien navega con teclado ve dónde quedó", () => {
    render(state);
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveClass("outline-none");
  });

  it("trae su texto, una acción principal, las secundarias y una salida a ayuda", () => {
    render(state);
    expect(screen.getByText("Puede que la dirección esté mal o que ya no esté disponible.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Ir al inicio" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Explorar cursos" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Pedir ayuda" })).toBeVisible();
  });

  it("el código de referencia va en letra chica, para dictarlo a soporte", () => {
    render(state);
    expect(screen.getByText("Código de referencia: abc123")).toHaveClass("text-caption");
  });

  it("va centrado y no pasa de 480 px", () => {
    const { container } = render(state);
    expect(container.firstElementChild).toHaveClass("mx-auto", "max-w-form");
  });

  it("el icono es decorativo: el título ya lo dice", () => {
    const { container } = render(state);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("no tiene faltas de accesibilidad", async () => {
    const { container } = render(<main>{state}</main>);
    expect(await a11yViolations(container)).toEqual([]);
  });
});
