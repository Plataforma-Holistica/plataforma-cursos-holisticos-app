import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { TextLink } from "@/ui/text-link";
import { ui } from "@/messages/es/ui";

import { a11yViolations } from "../setup/a11y";

describe("Button", () => {
  it("es un botón de verdad, y no envía un formulario si no se le pide", () => {
    render(<Button>Guardar cambios</Button>);
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toHaveAttribute("type", "button");
  });

  it("con `href` es un enlace: navega, no ejecuta", () => {
    render(<Button href="/cursos">Ver cursos</Button>);
    expect(screen.getByRole("link", { name: "Ver cursos" })).toHaveAttribute("href", "/cursos");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("se activa con teclado", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Guardar cambios</Button>);
    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("el principal ocupa todo el ancho en teléfono; los demás no", () => {
    render(
      <>
        <Button>Crear cuenta</Button>
        <Button variant="secondary">Cancelar</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toHaveClass("w-full", "sm:w-auto");
    expect(screen.getByRole("button", { name: "Cancelar" })).not.toHaveClass("w-full");
  });

  it("mide 48 px para el alumno y 40 px para administración", () => {
    render(
      <>
        <Button>Grande</Button>
        <Button size="md">Mediano</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Grande" })).toHaveClass("h-control");
    expect(screen.getByRole("button", { name: "Mediano" })).toHaveClass("h-control-sm");
  });

  it("cargando: dice lo que hace, se anuncia ocupado y no acepta un segundo clic", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Guardando…" onClick={onClick}>
        Guardar cambios
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Guardando…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  // `aria-busy` no se lee en voz alta, y un botón que se deshabilita se queda mudo. Quien
  // no ve el botón necesita oír que su clic sirvió.
  it("cargando: lo anuncia una región viva que ya estaba ahí antes de cargar", () => {
    const { rerender } = render(<Button loadingLabel="Guardando…">Guardar cambios</Button>);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveClass("sr-only");

    rerender(
      <Button loading loadingLabel="Guardando…">
        Guardar cambios
      </Button>,
    );
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Guardando…");
  });

  it("un botón sin texto de carga no trae región viva", () => {
    render(<Button>Guardar cambios</Button>);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("cargando no se ve apagado como un botón inactivo: su texto sigue siendo legible", () => {
    const { rerender } = render(<Button disabled>Entrar</Button>);
    expect(screen.getByRole("button")).toHaveClass("disabled:text-text-disabled");

    rerender(
      <Button loading loadingLabel="Entrando…">
        Entrar
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).not.toHaveClass("disabled:text-text-disabled");
    expect(button).toHaveClass("disabled:text-text-2");
  });

  it("cargando conserva su ancho: el texto de reposo sigue ahí, oculto", () => {
    render(
      <Button loading loadingLabel="Guardando…">
        Guardar cambios
      </Button>,
    );
    const idle = screen.getByText("Guardar cambios");
    expect(idle).toHaveAttribute("aria-hidden", "true");
    expect(idle).toHaveClass("invisible");
  });

  it("deshabilitado siempre tiene al lado la razón, en texto", () => {
    render(
      <Button disabled disabledReason="Espera 30 segundos para intentarlo otra vez.">
        Entrar
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Entrar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Espera 30 segundos para intentarlo otra vez.");
    expect(screen.getByText("Espera 30 segundos para intentarlo otra vez.")).toBeVisible();
  });

  it("las cuatro variantes no tienen faltas de accesibilidad", async () => {
    const { container } = render(
      <>
        <Button>Principal</Button>
        <Button variant="secondary">Secundario</Button>
        <Button variant="text">De texto</Button>
        <Button variant="danger">Cancelar suscripción</Button>
        <Button href="/ayuda" variant="secondary">
          Ir a ayuda
        </Button>
        <Button loading loadingLabel="Enviando…">
          Enviar
        </Button>
        <Button disabled disabledReason="Falta aceptar los términos.">
          Continuar
        </Button>
      </>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("Spinner", () => {
  it("siempre tiene nombre: «Cargando…» si no se le da otro", () => {
    render(<Spinner />);
    expect(screen.getByRole("status")).toHaveTextContent(ui.spinner.loading);
  });

  it("acepta el nombre de lo que se espera", () => {
    render(<Spinner label="Cargando tus cursos…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Cargando tus cursos…");
  });

  it("con movimiento reducido es una barra quieta con su texto, no un arco que gira", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector("svg")).toHaveClass("animate-spin", "motion-reduce:hidden");
    expect(screen.getByText(ui.spinner.loading)).toHaveClass("sr-only", "motion-reduce:not-sr-only");
    expect(container.querySelector("[data-still]")).toHaveClass("hidden", "motion-reduce:block");
  });

  it.each([
    [16, "size-4"],
    [24, "size-6"],
    [40, "size-10"],
  ] as const)("a %d px usa %s", (size, className) => {
    const { container } = render(<Spinner size={size} />);
    expect(container.querySelector("svg")).toHaveClass(className);
  });

  it("dentro de otro control es decorativo: no se anuncia dos veces", () => {
    const { container } = render(<Spinner decorative />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("no tiene faltas de accesibilidad", async () => {
    const { container } = render(<Spinner />);
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("TextLink", () => {
  it("es un enlace", () => {
    render(<TextLink href="/ayuda">Ir a ayuda</TextLink>);
    expect(screen.getByRole("link", { name: "Ir a ayuda" })).toHaveAttribute("href", "/ayuda");
  });

  it("si abre otra pestaña lo dice, y no deja la puerta abierta a la página de destino", () => {
    render(
      <TextLink href="https://example.com/terminos" external>
        Términos y condiciones
      </TextLink>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAccessibleName(`Términos y condiciones ${ui.link.newTab}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("no tiene faltas de accesibilidad", async () => {
    const { container } = render(
      <p>
        <TextLink href="/ayuda">Ir a ayuda</TextLink>{" "}
        <TextLink href="https://example.com" external>
          Aviso de privacidad
        </TextLink>
      </p>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});
