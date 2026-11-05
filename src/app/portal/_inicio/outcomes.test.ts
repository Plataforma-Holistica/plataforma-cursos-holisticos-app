import { describe, expect, it } from "vitest";

import type { DashboardValue } from "@/services/teachers/dashboard-data";

import { dashboardView, firstSteps, isFirstTime } from "./outcomes";

// PA-41 (T-408): lo que se pinta con cada respuesta del panel. Sin corrida buena no hay cifra; si la última falló, se dice de cuándo son las que se ven;
// la serie enlaza solo lo cerrado; y «Para empezar» sale solo a quien nunca publicó.

const COURSE = "c0000000-0000-4000-8000-000000000001";
const RUN = { estimatedCents: 123_456, fullLessons: 1_214, halfLessons: 37, students: 58, updatedAt: "2031-03-12T11:40:00.000Z" };

const VALUE: DashboardValue = {
  hasPublished: true,
  current: { period: "2031-03", run: RUN, lastFailed: false, stale: false },
  courses: [{ courseId: COURSE, title: "Respirar para volver", owned: true, figures: { fullLessons: 150, halfLessons: 22, students: 41 } }],
  series: [
    { period: "2031-01", cents: 98_000, estimated: false },
    { period: "2030-12", cents: null, estimated: false },
    { period: "2031-02", cents: 101_234, estimated: true },
  ],
};
const TAX = { version: 1, canSave: true };

describe("el mes en curso", () => {
  it("con corrida buena: el encabezado, la fecha con su hora, y las cuatro cifras", () => {
    const view = dashboardView(VALUE, TAX, false);
    expect(view.firstTime).toBeNull();
    expect(view.month).toBe("Marzo de 2031, en curso");
    expect(view.updated).toBe("Actualizado el 12 de marzo de 2031 a las 5:40 a.m., hora del centro de México.");
    expect(view.runNotice).toBeNull();
    expect(view.tiles).toEqual({
      estimated: {
        value: "$1,234.56",
        context:
          "Actualizado el 12 de marzo de 2031. La cifra final sale al cierre y puede subir o bajar: la cuota de cada alumno se reparte entre todos los maestros que ve en el mes.",
      },
      fullLessons: "1,214",
      halfLessons: "37",
      students: "58",
    });
    expect(view.noViews).toBe(false);
  });

  it("sin corrida: ninguna cifra, ni un cero, y lo dice", () => {
    const view = dashboardView({ ...VALUE, current: { period: "2031-03", run: null, lastFailed: false, stale: false } }, TAX, false);
    expect(view.updated).toBeNull();
    expect(view.tiles).toEqual({ estimated: { value: null, context: null }, fullLessons: null, halfLessons: null, students: null });
    expect(view.runNotice).toEqual({ tone: "neutral", text: "Todavía no hay cifras de este mes: se calculan cada noche." });
    expect(view.noViews).toBe(false);
  });

  it("la última falló: lo dice, con la fecha de lo que se ve, y no inventa nada", () => {
    const view = dashboardView({ ...VALUE, current: { period: "2031-03", run: RUN, lastFailed: true, stale: false } }, TAX, false);
    expect(view.runNotice).toEqual({ tone: "warning", text: "No se pudieron actualizar tus cifras. Estas son del 12 de marzo de 2031." });
    expect(view.tiles.estimated.value).toBe("$1,234.56");
    const none = dashboardView({ ...VALUE, current: { period: "2031-03", run: null, lastFailed: true, stale: false } }, TAX, false);
    expect(none.runNotice).toEqual({ tone: "warning", text: "No se pudieron actualizar tus cifras. Todavía no hay cifras de este mes." });
    expect(none.tiles.estimated.value).toBeNull();
  });

  it("una corrida buena vieja (la noche no la renovó) se dice como una fallida: lo que se ve es de antes", () => {
    const view = dashboardView({ ...VALUE, current: { period: "2031-03", run: RUN, lastFailed: false, stale: true } }, TAX, false);
    expect(view.runNotice).toEqual({ tone: "warning", text: "No se pudieron actualizar tus cifras. Estas son del 12 de marzo de 2031." });
    expect(view.tiles.estimated.value).toBe("$1,234.56");
  });

  it("publicado y sin vistas: ceros, porque se midieron, con su frase", () => {
    const zero = { ...RUN, estimatedCents: 0, fullLessons: 0, halfLessons: 0, students: 0 };
    const view = dashboardView({ ...VALUE, current: { period: "2031-03", run: zero, lastFailed: false, stale: false } }, TAX, false);
    expect(view.tiles).toMatchObject({ estimated: { value: "$0.00" }, fullLessons: "0", halfLessons: "0", students: "0" });
    expect(view.noViews).toBe(true);
  });
});

describe("por curso y la serie", () => {
  it("cada curso con su enlace y sus cifras; sin corrida, sin cifras; sin título, lo dice", () => {
    expect(dashboardView(VALUE, TAX, false).courses).toEqual([
      { key: COURSE, title: "Respirar para volver", href: `/portal/cursos/${COURSE}`, fullLessons: "150", halfLessons: "22", students: "41" },
    ]);
    const bare = dashboardView({ ...VALUE, courses: [{ courseId: COURSE, title: null, owned: true, figures: null }] }, TAX, false).courses;
    expect(bare).toEqual([{ key: COURSE, title: "Curso sin título", href: `/portal/cursos/${COURSE}`, fullLessons: null, halfLessons: null, students: null }]);
  });

  it("un curso que ya no es suyo sale con sus cifras y sin enlace: su editor es de otro", () => {
    const [course] = dashboardView({ ...VALUE, courses: [{ ...VALUE.courses[0]!, owned: false }] }, TAX, false).courses;
    expect(course).toMatchObject({ title: "Respirar para volver", href: null, fullLessons: "150" });
  });

  it("los cerrados con su total y su liquidación; uno sin total, en cero; el que todavía no cierra, estimado y sin enlace", () => {
    expect(dashboardView(VALUE, TAX, false).series).toEqual([
      { key: "2031-01", label: "Enero de 2031", amount: "$980.00", value: 98_000, estimated: false, href: "/portal/pagos/2031-01" },
      { key: "2030-12", label: "Diciembre de 2030", amount: "$0.00", value: 0, estimated: false, href: "/portal/pagos/2030-12" },
      { key: "2031-02", label: "Febrero de 2031", amount: "$1,012.34", value: 101_234, estimated: true, note: "Todavía sin cerrar" },
    ]);
  });

  it("en cierre sin corrida buena, sin cifra", () => {
    const [bar] = dashboardView({ ...VALUE, series: [{ period: "2031-02", cents: null, estimated: true }] }, TAX, false).series;
    expect(bar).toMatchObject({ amount: null, value: null, estimated: true });
    expect(bar).not.toHaveProperty("href");
  });
});

describe("«Para empezar»", () => {
  const never: DashboardValue = { hasPublished: false, current: { period: "2031-03", run: null, lastFailed: false, stale: false }, courses: [], series: [] };

  it("solo a quien nunca publicó: quien despublicó todo sigue viendo lo suyo", () => {
    expect(isFirstTime(never)).toBe(true);
    expect(isFirstTime({ ...never, hasPublished: true })).toBe(false);
    expect(isFirstTime({ ...never, courses: VALUE.courses })).toBe(false);
    expect(isFirstTime({ ...never, series: VALUE.series })).toBe(false);
    expect(dashboardView(never, TAX, false).firstTime).not.toBeNull();
  });

  it("los datos fiscales: pendientes enlazan, hechos no, y sin saberlo no se dice el estado", () => {
    expect(firstSteps({ version: 0, canSave: true }, false)[0]).toEqual({
      key: "datos-fiscales",
      label: "Captura tus datos fiscales y bancarios",
      href: "/portal/datos-fiscales",
      state: "Pendiente",
    });
    expect(firstSteps({ version: 2, canSave: true }, false)[0]).toMatchObject({ href: null, state: "Listo" });
    expect(firstSteps(null, false)[0]).toMatchObject({ href: "/portal/datos-fiscales", state: null });
    // Un suspendido por fraude no los captura: no se le ofrece.
    expect(firstSteps({ version: 0, canSave: false }, false)[0]).toMatchObject({ href: null, state: "Pendiente" });
  });

  it("un suspendido en solo lectura no recibe el enlace a crear un curso", () => {
    expect(firstSteps(null, true)[1]).toEqual({ key: "primer-curso", label: "Crea y envía tu primer curso", href: null, state: "Pendiente" });
    expect(dashboardView(never, TAX, true).firstTime?.[1]?.href).toBeNull();
  });

  it("el primer curso lleva a sus cursos", () => {
    expect(firstSteps(null, false)[1]).toEqual({ key: "primer-curso", label: "Crea y envía tu primer curso", href: "/portal/cursos", state: "Pendiente" });
  });
});
