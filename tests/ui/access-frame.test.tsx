import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { AccessFrame } from "@/app/(cuenta)/_lib/access-frame";
import { terms } from "@/messages/es/terms";

// El marco de las pantallas de acceso (diseño, sección 3.12; T-614, parte 3): la foto de acceso con su
// velo y el logotipo, junto al formulario de siempre. PA-12 y PA-15 lo usan con el logotipo y sin foto
// (decisión de Sergio del 2026-11-05).

function Form() {
  return (
    <main id="contenido">
      <h1>Inicia sesión</h1>
    </main>
  );
}

describe("AccessFrame", () => {
  it("con foto: el formulario de siempre, la foto decorativa y el logotipo que lleva a la portada", () => {
    const { container } = render(<AccessFrame>{<Form />}</AccessFrame>);
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1, name: "Inicia sesión" }));
    const photo = container.querySelector("img");
    expect(photo).toHaveAttribute("alt", "");
    expect(photo?.getAttribute("src")).toContain("acceso-ondas");
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("link", { name: terms.Plataforma })).toHaveAttribute("href", "/");
  });

  it("en computadora, cada pantalla ocupa el ancho de su columna: en una columna flexible se encogería", () => {
    render(<AccessFrame>{<Form />}</AccessFrame>);
    expect(screen.getByRole("main").parentElement).toHaveClass("lg:*:w-full");
  });

  it("sin foto: el logotipo y el formulario, sin ninguna imagen", () => {
    const { container } = render(<AccessFrame photo={false}>{<Form />}</AccessFrame>);
    expect(container.querySelector("img")).toBeNull();
    expect(within(screen.getByRole("banner")).getByRole("link", { name: terms.Plataforma })).toHaveAttribute("href", "/");
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("el logotipo mide lo que pide el toque", () => {
    render(<AccessFrame>{<Form />}</AccessFrame>);
    expect(within(screen.getByRole("banner")).getByRole("link")).toHaveClass("min-h-touch");
  });

  it.each([true, false])("con foto %s pasa las reglas automáticas de accesibilidad", async (photo) => {
    const { container } = render(<AccessFrame photo={photo}>{<Form />}</AccessFrame>);
    expect(await a11yViolations(container)).toEqual([]);
  });
});

// Qué pantallas lo usan. Leído del código: cada página envuelve en el marco la pantalla de siempre, y los
// estados de pantalla completa (suspendida, «no se supo», el enlace que ya no sirve) siguen como están.
// Con `join` y no con `URL`: en el DOM simulado `URL` no es el de Node. Vitest corre desde la raíz del proyecto.
const pageOf = (path: string) => readFileSync(join(process.cwd(), "src/app/(cuenta)", path, "page.tsx"), "utf8");

describe("las pantallas de acceso usan el marco", () => {
  it.each([
    ["registro", "SignUpScreen"],
    ["entrar", "SignInScreen"],
    ["recuperar", "RecoverScreen"],
    ["recuperar/[token]", "ChangePasswordScreen"],
    ["verificar", "CheckMailScreen"],
    ["verificar/[token]", "CompleteScreen"],
  ])("%s, con la foto", (path, screenName) => {
    const code = pageOf(path);
    const uses = [...code.matchAll(new RegExp(`<${screenName}\\b`, "g"))];
    expect(uses.length, `${path} pinta ${screenName}`).toBeGreaterThan(0);
    for (const use of code.matchAll(new RegExp(`<${screenName}\\b`, "g"))) {
      const before = code.slice(0, use.index);
      expect(before.lastIndexOf("<AccessFrame>"), `${path}: ${screenName} dentro del marco con foto`).toBeGreaterThan(before.lastIndexOf("</AccessFrame>"));
    }
    expect(code).not.toContain("photo={false}");
  });

  it.each([
    ["entrar/segundo-factor", "SecondFactorScreen"],
    ["entrar/segundo-factor/configurar", "FactorSetupScreen"],
    ["consentimientos", "ConsentsScreen"],
  ])("%s, sin la foto", (path, screenName) => {
    const code = pageOf(path);
    expect(code).toMatch(new RegExp(`<AccessFrame photo=\\{false\\}>\\s*<${screenName}\\b`));
  });
});
