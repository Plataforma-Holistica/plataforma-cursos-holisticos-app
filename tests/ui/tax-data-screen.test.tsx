import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-48, datos fiscales y bancarios (T-409). Las acciones de servidor son la frontera: cambian por lo que contestarían. Se mira lo que un DOM
// simulado sí ve: qué se pinta, que lo oculto no conviva con un formulario, y que lo escrito no se pierda con una respuesta.
const actions = vi.hoisted(() => ({ revealTaxDataAction: vi.fn(), saveTaxDataAction: vi.fn() }));
vi.mock("@/app/portal/_fiscal/actions", () => actions);

import { TaxCapture, TaxReveal } from "@/app/portal/_fiscal/screen";
import type { RevealState, SaveState } from "@/app/portal/_fiscal/outcomes";
import { portal } from "@/messages/es/portal";

import { a11yViolations } from "../setup/a11y";

const text = portal.taxData;

function answersReveal(state: RevealState) {
  actions.revealTaxDataAction.mockImplementation(() => Promise.resolve(state));
}
function answersSave(state: SaveState) {
  actions.saveTaxDataAction.mockImplementation(() => Promise.resolve(state));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ver lo guardado", () => {
  it("antes de mostrar nada pide la contraseña, y no pinta ningún dato", async () => {
    const { container } = render(<TaxReveal canChange />);
    expect(screen.getByLabelText(text.password)).toBeTruthy();
    expect(screen.queryByText(/••••/)).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con lo oculto a la vista no hay ningún formulario: sin JavaScript, el estado viajaría en él", async () => {
    answersReveal({ kind: "revealed", data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: "•••• 7771", date: "31 de octubre de 2026" }, attempt: 1 });
    const { container } = render(<TaxReveal canChange />);
    await userEvent.type(screen.getByLabelText(text.password), "la-de-ella");
    await userEvent.click(screen.getByRole("button", { name: text.reveal.submit }));
    expect(await screen.findByText("•••• 7771")).toBeTruthy();
    expect(screen.getByText("•••• 1GR8")).toBeTruthy();
    expect(screen.getByText("•••• Díaz")).toBeTruthy();
    expect(screen.getByText(/Régimen Simplificado de Confianza/)).toBeTruthy();
    expect(screen.getByText(/31 de octubre de 2026/)).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    // Enlaces de carga completa: el estado no sobrevive a pedir la página otra vez.
    expect(screen.getByRole("link", { name: text.reveal.hide }).getAttribute("href")).toBe("/portal/datos-fiscales");
    expect(screen.getByRole("link", { name: text.change }).getAttribute("href")).toBe("/portal/datos-fiscales?cambiar=1");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("el botón pulsado desaparece con el formulario: el foco va al título de lo mostrado, para que un lector de pantalla se entere", async () => {
    answersReveal({ kind: "revealed", data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: "•••• 7771", date: "31 de octubre de 2026" }, attempt: 1 });
    render(<TaxReveal canChange />);
    await userEvent.type(screen.getByLabelText(text.password), "la-de-ella");
    await userEvent.click(screen.getByRole("button", { name: text.reveal.submit }));
    const title = await screen.findByRole("heading", { name: text.reveal.title });
    expect(document.activeElement).toBe(title);
  });

  it("a quien se fue a otra cosa mientras esperaba no se le quita el foco", async () => {
    let answer: (state: RevealState) => void = () => undefined;
    actions.revealTaxDataAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    render(
      <>
        <TaxReveal canChange />
        <button type="button">otra cosa</button>
      </>,
    );
    await userEvent.type(screen.getByLabelText(text.password), "la-de-ella");
    await userEvent.click(screen.getByRole("button", { name: text.reveal.submit }));
    const other = screen.getByRole("button", { name: "otra cosa" });
    other.focus();
    await act(async () => {
      answer({ kind: "revealed", data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: "•••• 7771", date: "31 de octubre de 2026" }, attempt: 1 });
      await Promise.resolve();
    });
    await screen.findByRole("heading", { name: text.reveal.title });
    expect(document.activeElement).toBe(other);
  });

  it("un maestro suspendido ve lo suyo y no se le ofrece cambiarlo", async () => {
    answersReveal({ kind: "revealed", data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: "•••• 7771", date: "31 de octubre de 2026" }, attempt: 1 });
    render(<TaxReveal canChange={false} />);
    await userEvent.type(screen.getByLabelText(text.password), "la-de-ella");
    await userEvent.click(screen.getByRole("button", { name: text.reveal.submit }));
    await screen.findByText("•••• 7771");
    expect(screen.queryByRole("link", { name: text.change })).toBeNull();
  });

  it("la contraseña equivocada se dice en el campo, y el campo queda vacío", async () => {
    answersReveal({ kind: "failed", reason: "wrong_password", attempt: 1 });
    render(<TaxReveal canChange />);
    const field = screen.getByLabelText<HTMLInputElement>(text.password);
    await userEvent.type(field, "otra");
    await userEvent.click(screen.getByRole("button", { name: text.reveal.submit }));
    expect((await screen.findAllByText(text.problems.password)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText<HTMLInputElement>(text.password).value).toBe("");
  });

  it("sin llave lo dice", async () => {
    answersReveal({ kind: "failed", reason: "off", attempt: 1 });
    render(<TaxReveal canChange />);
    await userEvent.type(screen.getByLabelText(text.password), "x");
    await userEvent.click(screen.getByRole("button", { name: text.reveal.submit }));
    expect(await screen.findByText(text.failed.off)).toBeTruthy();
  });
});

describe("capturar", () => {
  it("pide los cuatro datos y la contraseña, con la frase de quién los ve fuera del formulario", async () => {
    const { container } = render(<TaxCapture seen={0} changing={false} />);
    expect(screen.getByRole("textbox", { name: /RFC/ })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Régimen fiscal/ })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /Razón social/ })).toBeTruthy();
    const clabe = screen.getByRole("textbox", { name: /CLABE/ });
    // El teclado numérico en el teléfono, y que el navegador no se lo guarde.
    expect(clabe.getAttribute("inputmode")).toBe("numeric");
    expect(clabe.getAttribute("autocomplete")).toBe("off");
    expect(screen.getByLabelText(text.password)).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('input[name="seen"]')?.value).toBe("0");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("lleva la versión que tiene a la vista", () => {
    const { container } = render(<TaxCapture seen={7} changing />);
    expect(container.querySelector<HTMLInputElement>('input[name="seen"]')?.value).toBe("7");
  });

  it("todos los regímenes del catálogo están en la lista, y solo esos", () => {
    render(<TaxCapture seen={0} changing={false} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: /Régimen fiscal/ });
    const values = [...select.options].map((option) => option.value).filter((value) => value !== "");
    expect(values).toHaveLength(19);
    expect(values).toContain("626");
    expect(values).not.toContain("999");
  });

  it("al cambiar dice a qué pagos aplica y ofrece volver; al capturar por primera vez, no", () => {
    const first = render(<TaxCapture seen={0} changing={false} />);
    expect(screen.queryByText(text.capture.appliesTo)).toBeNull();
    first.unmount();
    render(<TaxCapture seen={2} changing />);
    expect(screen.getByText(text.capture.appliesTo)).toBeTruthy();
    expect(screen.getByRole("link", { name: text.capture.cancel }).getAttribute("href")).toBe("/portal/datos-fiscales");
  });

  it("nunca pinta un dato de antes: cambiar vuelve a pedir el dato completo", () => {
    const { container } = render(<TaxCapture seen={2} changing />);
    for (const input of container.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')) expect(input.value).toBe("");
  });

  it("con un error se dice el formato esperado en su campo; lo escrito se queda y la contraseña no", async () => {
    answersSave({ kind: "invalid", problems: { clabe: "length", regime: "payee" }, attempt: 1 });
    render(<TaxCapture seen={0} changing={false} />);
    await userEvent.type(screen.getByRole("textbox", { name: /RFC/ }), "GODE561231GR8");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Régimen fiscal/ }), "601");
    await userEvent.type(screen.getByRole("textbox", { name: /Razón social/ }), "Elena Gómez");
    await userEvent.type(screen.getByRole("textbox", { name: /CLABE/ }), "123");
    await userEvent.type(screen.getByLabelText(text.password), "la-de-ella");
    await userEvent.click(screen.getByRole("button", { name: text.capture.submit }));

    expect((await screen.findAllByText(text.problems.clabe.length)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(text.problems.regime.payee).length).toBeGreaterThan(0);
    await act(() => Promise.resolve());
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: /RFC/ }).value).toBe("GODE561231GR8");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: /Régimen fiscal/ }).value).toBe("601");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: /Razón social/ }).value).toBe("Elena Gómez");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: /CLABE/ }).value).toBe("123");
    expect(screen.getByLabelText<HTMLInputElement>(text.password).value).toBe("");
  });

  it("una respuesta que no guardó deja lo escrito", async () => {
    answersSave({ kind: "failed", reason: "unavailable", attempt: 1 });
    render(<TaxCapture seen={1} changing />);
    await userEvent.type(screen.getByRole("textbox", { name: /RFC/ }), "GODE561231GR8");
    await userEvent.type(screen.getByLabelText(text.password), "x");
    await userEvent.click(screen.getByRole("button", { name: text.capture.submit }));
    expect(await screen.findByText(text.failed.unavailable)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: /RFC/ }).value).toBe("GODE561231GR8");
  });

  it("le da al gestor de contraseñas el correo como usuario: si no, tomaría la CLABE, que es el texto de antes", () => {
    const { container } = render(<TaxCapture seen={0} changing={false} email="ana@prueba.test" />);
    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    expect(username?.value).toBe("ana@prueba.test");
    expect(username?.hidden).toBe(true);
  });
});
