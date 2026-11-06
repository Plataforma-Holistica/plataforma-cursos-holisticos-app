import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { TeacherCard } from "@/ui/teacher-card";

// La tarjeta de maestro (diseño, sección 5.3; T-210). Sin retrato lleva la foto de ambiente de su primera
// práctica (T-614, parte 4; decisión de Sergio del 2026-11-05); sin práctica, la inicial sobre el tono neutro.

describe("TeacherCard", () => {
  it("un solo enlace, con el nombre y las prácticas", () => {
    render(<TeacherCard href="/maestros/ana" name="Ana Robles" practices={["Yoga"]} tone={5} practicePosition={1} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/maestros/ana");
    expect(screen.getByRole("link")).toHaveAccessibleName("Ana Robles, maestro de Yoga");
  });

  it("con práctica, la foto de ambiente de su práctica, decorativa, en vez de la inicial", () => {
    const { container } = render(<TeacherCard href="/maestros/ana" name="Ana Robles" practices={["Yoga"]} tone={5} practicePosition={1} />);
    const photo = container.querySelector("img");
    expect(photo).toHaveAttribute("alt", "");
    expect(photo?.getAttribute("src")).toMatch(/practica-/);
    expect(screen.queryByText("A")).toBeNull();
  });

  it("dos prácticas de distinto orden llevan fotos distintas", () => {
    const { container } = render(
      <>
        <TeacherCard href="/maestros/ana" name="Ana" practices={["Yoga"]} tone={5} practicePosition={1} />
        <TeacherCard href="/maestros/beto" name="Beto" practices={["Sonido"]} tone={2} practicePosition={2} />
      </>,
    );
    const [first, second] = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(first).not.toBe(second);
  });

  it("sin práctica, la inicial", () => {
    const { container } = render(<TeacherCard href="/maestros/beto" name="beto Luna" practices={[]} tone={null} practicePosition={null} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("pasa las reglas automáticas de accesibilidad", async () => {
    const { container } = render(<TeacherCard href="/maestros/ana" name="Ana Robles" practices={["Yoga"]} tone={5} practicePosition={1} />);
    expect(await a11yViolations(container)).toEqual([]);
  });
});
