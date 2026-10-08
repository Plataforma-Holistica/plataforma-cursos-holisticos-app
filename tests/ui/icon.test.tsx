import { render, screen } from "@testing-library/react";
import { Info } from "lucide";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { Icon } from "@/ui/icon";

describe("Icon", () => {
  it("dibuja el icono con trazo de 1.5 sobre la rejilla de 24", () => {
    const { container } = render(<Icon icon={Info} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("stroke-width", "1.5");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg?.querySelectorAll("circle, path")).toHaveLength(Info.length);
  });

  it("sin nombre es decorativo: no existe para un lector de pantalla", () => {
    const { container } = render(<Icon icon={Info} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("con nombre es una imagen con ese nombre", () => {
    render(<Icon icon={Info} label="Información" />);
    expect(screen.getByRole("img", { name: "Información" })).not.toHaveAttribute("aria-hidden");
  });

  it.each([
    [16, "size-4"],
    [20, "size-5"],
    [24, "size-6"],
  ] as const)("a %d px usa %s", (size, className) => {
    const { container } = render(<Icon icon={Info} size={size} />);
    expect(container.querySelector("svg")).toHaveClass(className);
  });

  it("no se encoge dentro de un renglón, y mide 20 px si no se dice otra cosa", () => {
    const { container } = render(<Icon icon={Info} />);
    expect(container.querySelector("svg")).toHaveClass("size-5", "shrink-0");
  });

  it("no tiene faltas de accesibilidad, con nombre o sin él", async () => {
    const { container } = render(
      <p>
        <Icon icon={Info} /> <Icon icon={Info} label="Información" />
      </p>,
    );
    expect(await a11yViolations(container)).toEqual([]);
  });
});
