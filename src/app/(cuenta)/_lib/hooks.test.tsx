import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { afterInteraction, QUIET_MS } from "./hooks";

// Cuándo se pinta lo que se vio al salir de un campo: cuando termina el clic o la tecla que
// sacó el foco, no en medio. Que así no se pierde el clic lo prueba el extremo a extremo,
// con un navegador de verdad; aquí se cuida el orden.

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  // Ningún caso deja el botón abajo para el siguiente.
  fireEvent.pointerUp(document.body);
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("lo que espera a que termine la interacción en curso", () => {
  it("con el botón del ratón abajo no corre, por mucho que se tarde en soltarlo", () => {
    const work = vi.fn();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    afterInteraction(work);
    vi.advanceTimersByTime(60_000);
    expect(work).not.toHaveBeenCalled();
  });

  it("al soltar el botón corre después del clic, cuando el clic ya llegó a su destino", () => {
    const order: string[] = [];
    const button = document.body.appendChild(document.createElement("button"));
    button.addEventListener("click", () => order.push("clic"));
    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button);
    afterInteraction(() => order.push("mensaje"));
    // Un navegador despacha esto de corrido al soltar el botón.
    fireEvent.pointerUp(button);
    fireEvent.mouseUp(button);
    fireEvent.click(button);
    expect(order).toEqual(["clic"]);
    vi.advanceTimersByTime(0);
    expect(order).toEqual(["clic", "mensaje"]);
    button.remove();
  });

  it("si el gesto se cancela, también termina", () => {
    const work = vi.fn();
    fireEvent.pointerDown(document.body);
    afterInteraction(work);
    fireEvent.pointerCancel(document.body);
    vi.advanceTimersByTime(0);
    expect(work).toHaveBeenCalledOnce();
  });

  it("con el teclado corre al soltar la tecla", () => {
    const work = vi.fn();
    fireEvent.keyDown(document.body, { key: "Tab" });
    afterInteraction(work);
    expect(work).not.toHaveBeenCalled();
    fireEvent.keyUp(document.body, { key: "Tab" });
    vi.advanceTimersByTime(0);
    expect(work).toHaveBeenCalledOnce();
  });

  it("sin botón abajo y sin tecla, corre pasado un momento: el foco también se mueve sin ratón ni teclado", () => {
    const work = vi.fn();
    afterInteraction(work);
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(work).not.toHaveBeenCalled();
    // El reloj simulado le da un milisegundo a lo que se programa desde otro temporizador.
    vi.advanceTimersByTime(2);
    expect(work).toHaveBeenCalledOnce();
  });

  it("después de soltar el botón, la siguiente salida de campo ya no espera a otro clic", () => {
    const work = vi.fn();
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    afterInteraction(work);
    vi.advanceTimersByTime(QUIET_MS + 1);
    expect(work).toHaveBeenCalledOnce();
  });

  it("corre una sola vez, y deja de escuchar", () => {
    const work = vi.fn();
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    afterInteraction(work);
    fireEvent.keyUp(document.body);
    fireEvent.keyUp(document.body);
    fireEvent.pointerUp(document.body);
    vi.advanceTimersByTime(QUIET_MS * 10);
    expect(work).toHaveBeenCalledOnce();
    expect(added).toHaveBeenCalledTimes(3);
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(added.mock.calls.map(([type]) => type).sort());
    added.mockRestore();
    removed.mockRestore();
  });

  it("dos salidas de campo antes de soltar se pintan las dos, en su orden", () => {
    const order: string[] = [];
    fireEvent.pointerDown(document.body);
    afterInteraction(() => order.push("primera"));
    afterInteraction(() => order.push("segunda"));
    fireEvent.pointerUp(document.body);
    vi.advanceTimersByTime(0);
    expect(order).toEqual(["primera", "segunda"]);
  });
});
