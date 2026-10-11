import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { afterInteraction, pointerIsPressedInside, QUIET_MS, useDelayIsOver, useSeenOnBlur } from "./hooks";

// Cuándo se pinta lo que se vio al salir de un campo: cuando termina el clic o la tecla que
// sacó el foco, no en medio. Que así no se pierde el clic lo prueba el extremo a extremo,
// con un navegador de verdad; aquí se cuida el orden.
//
// Y dos ganchos más: la espera que se cuenta sin comparar relojes, y qué se le dice a un
// campo cuando lo visto al salir de él y la última revisión del formulario no coinciden.

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

describe("con el botón abajo, el teclado no cuenta", () => {
  it("soltar una tecla no termina nada: el clic sigue en curso", () => {
    const work = vi.fn();
    fireEvent.pointerDown(document.body);
    afterInteraction(work);
    fireEvent.keyUp(document.body, { key: "Shift" });
    vi.advanceTimersByTime(60_000);
    expect(work).not.toHaveBeenCalled();
    fireEvent.pointerUp(document.body);
    vi.advanceTimersByTime(0);
    expect(work).toHaveBeenCalledOnce();
  });
});

describe("una espera que solo se cuenta", () => {
  const wait = (ms: number | null, round = 0) =>
    renderHook((props: { ms: number | null; round: number }) => useDelayIsOver(props.ms, props.round), { initialProps: { ms, round } });

  it("pasa cuando pasa su tiempo, diga lo que diga el reloj del navegador", () => {
    const { result } = wait(60_000);
    expect(result.current).toBe(false);
    // Adelantar la hora no es dejar pasar el tiempo.
    act(() => void vi.setSystemTime(Date.now() + 86_400_000));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(59_999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("sin espera no hay nada que pasar", () => {
    const { result } = wait(null);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(false);
  });

  it.each([0, -5_000])("una espera de %i milisegundos pasa en el acto", (ms) => {
    const { result } = wait(ms);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("otra espera, aunque dure lo mismo, se cuenta de nuevo", () => {
    const { result, rerender } = wait(60_000);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(true);
    rerender({ ms: 60_000, round: 1 });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(59_999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("la misma espera no vuelve a empezar porque la pantalla se pinte otra vez", () => {
    const { result, rerender } = wait(60_000);
    act(() => void vi.advanceTimersByTime(30_000));
    rerender({ ms: 60_000, round: 0 });
    act(() => void vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(true);
  });

  it("al quitarse de la pantalla deja de contar", () => {
    const { unmount } = wait(60_000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("lo que se le dice a un campo", () => {
  type Problem = "corto" | "largo";
  const field = (checked: Problem | undefined, round = 0) =>
    renderHook((props: { checked: Problem | undefined; round: number }) => useSeenOnBlur(props.checked, props.round), {
      initialProps: { checked, round },
    });
  /** Deja pasar lo que tarda en pintarse lo visto al salir de un campo, sin teclado ni ratón. */
  const settle = () => act(() => void vi.advanceTimersByTime(QUIET_MS + 1));

  it("de entrada, lo que dijo la última revisión", () => {
    expect(field("largo").result.current[0]).toBe("largo");
    expect(field(undefined).result.current[0]).toBeUndefined();
  });

  it("lo visto al salir del campo manda sobre esa revisión, sea un problema o que ya está bien", () => {
    const { result } = field("largo");
    act(() => result.current[1]("corto"));
    // No en el acto: cuando termina la interacción.
    expect(result.current[0]).toBe("largo");
    settle();
    expect(result.current[0]).toBe("corto");
    act(() => result.current[1](null));
    settle();
    expect(result.current[0]).toBeUndefined();
  });

  it("una revisión más nueva manda sobre lo visto antes al salir del campo", () => {
    const { result, rerender } = field(undefined);
    act(() => result.current[1](null));
    settle();
    rerender({ checked: "corto", round: 1 });
    expect(result.current[0]).toBe("corto");
  });

  it("el campo vacío al salir vuelve a decir lo de la última revisión", () => {
    const { result } = field("largo");
    act(() => result.current[1]("corto"));
    settle();
    act(() => result.current[1](undefined));
    settle();
    expect(result.current[0]).toBe("largo");
  });

  it("lo visto al salir del campo que se pinta después de una revisión más nueva ya no cuenta", () => {
    const { result, rerender } = field(undefined);
    // Salir del campo pulsando «Enviar»: lo visto espera al clic, y el clic trae otra revisión.
    act(() => result.current[1](null));
    rerender({ checked: "corto", round: 1 });
    settle();
    expect(result.current[0]).toBe("corto");
  });
});

describe("lo que encontró la revisión de los arreglos", () => {
  it("la misma ronda con otra duración es otra espera, y se cuenta entera", () => {
    const { result, rerender } = renderHook((props: { ms: number | null; round: number }) => useDelayIsOver(props.ms, props.round), {
      initialProps: { ms: 60_000 as number | null, round: 0 },
    });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(true);
    rerender({ ms: 59_000, round: 0 });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(58_999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("sabe sobre qué bajó el botón del ratón, mientras sigue abajo", () => {
    const field = document.body.appendChild(document.createElement("div"));
    const inside = field.appendChild(document.createElement("button"));
    const outside = document.body.appendChild(document.createElement("button"));
    expect(pointerIsPressedInside(field)).toBe(false);
    fireEvent.pointerDown(inside);
    expect(pointerIsPressedInside(field)).toBe(true);
    fireEvent.pointerUp(inside);
    expect(pointerIsPressedInside(field)).toBe(false);
    fireEvent.pointerDown(outside);
    expect(pointerIsPressedInside(field)).toBe(false);
    fireEvent.pointerUp(outside);
    field.remove();
    outside.remove();
  });

  it.each([
    ["el menú del botón derecho", () => fireEvent.contextMenu(document.body)],
    ["soltar lo que se arrastraba", () => fireEvent.dragEnd(document.body)],
    ["cambiar de ventana", () => fireEvent.blur(window)],
  ])("%s también suelta el botón: lo visto al salir de un campo no espera un clic que no viene", (_name, release) => {
    const button = document.body.appendChild(document.createElement("button"));
    fireEvent.pointerDown(button);
    expect(pointerIsPressedInside(document.body)).toBe(true);
    release();
    expect(pointerIsPressedInside(document.body)).toBe(false);
    // Sin botón abajo, lo siguiente ya no espera a que se suelte: sale con el teclado o solo.
    const work = vi.fn();
    afterInteraction(work);
    vi.advanceTimersByTime(QUIET_MS + 1);
    expect(work).toHaveBeenCalledOnce();
    button.remove();
  });
});
