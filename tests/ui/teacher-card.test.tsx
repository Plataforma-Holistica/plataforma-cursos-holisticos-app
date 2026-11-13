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

  // Cambió por el requisito (T-616, 3b-1): antes la foto salía del orden de la práctica (`posición % 2`), y dos maestros de la
  // misma práctica, o de dos prácticas pares, llevaban la misma. Ahora sale del maestro (su slug, el de su enlace): la misma
  // práctica no la decide.
  it("la foto es la del maestro, por su slug, no la de su práctica", () => {
    const srcOf = (href: string, practicePosition: number) => {
      const { container, unmount } = render(<TeacherCard href={href} name="Ana" practices={["Yoga"]} tone={5} practicePosition={practicePosition} />);
      const src = container.querySelector("img")?.getAttribute("src");
      unmount();
      return src;
    };
    // El mismo maestro con otra práctica primera: la misma foto.
    expect(srcOf("/maestros/ana", 1)).toBe(srcOf("/maestros/ana", 2));
    // Dos maestros de la misma práctica: entre varios, más de una foto.
    const photos = new Set(Array.from({ length: 12 }, (_, index) => srcOf(`/maestros/maestro-${index}`, 1)));
    expect(photos.size).toBeGreaterThan(1);
  });

  // Revisión de la 3b-1: el slug llega como prop; sin él (la portada pública todavía no lo pasa), sale del enlace.
  it("con `slug`, la foto sale de él y no del enlace", () => {
    const srcOf = (props: { slug?: string; href: string }) => {
      const { container, unmount } = render(<TeacherCard {...props} name="Ana" practices={["Yoga"]} tone={5} practicePosition={1} />);
      const src = container.querySelector("img")?.getAttribute("src");
      unmount();
      return src;
    };
    const slugs = Array.from({ length: 20 }, (_, index) => `maestra-${index}`);
    // Dos slugs con fotos distintas: el enlace de uno y el slug del otro.
    const [first, other] = [slugs[0] ?? "", slugs.find((slug) => srcOf({ href: `/maestros/${slug}` }) !== srcOf({ href: `/maestros/${slugs[0]}` })) ?? ""];
    expect(other).not.toBe("");
    expect(srcOf({ slug: other, href: `/maestros/${first}` })).toBe(srcOf({ href: `/maestros/${other}` }));
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
