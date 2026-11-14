import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { annualSaving, closedPlansDetour, confirmingHref, monthlyEquivalent, plansAnswerOf, plansHref, priceText, readPlansForm, readPlansQuery, savingText } from "./outcomes";

const DOC = "11111111-2222-4333-8444-555555555555";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

const FULL: [string, string][] = [
  ["plan", "monthly"],
  ["monto", "34900"],
  ["texto", DOC],
  ["volver", "/cursos/uno"],
  ["acepto", "on"],
];

describe("PA-04, lo que llega del formulario", () => {
  it("lee el plan, el monto y el texto vistos, a dónde volver y la casilla", () => {
    expect(readPlansForm(form(FULL))).toEqual({ plan: "monthly", amount: 34900, document: DOC, returnTo: "/cursos/uno", accepted: true });
  });

  it("lo que no es un formulario no se lee", () => {
    expect(readPlansForm({ plan: "monthly" })).toBeNull();
    expect(readPlansForm(null)).toBeNull();
  });

  it.each([
    ["un plan que no existe", "plan", "weekly"],
    ["un plan vacío", "plan", ""],
  ])("%s no es un plan", (_, name, value) => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === name ? [k, value] : [k, v]))))?.plan).toBeNull();
  });

  it.each(["0", "-1", "34.90", "1e5", "034900", "", "1234567890123"])("el monto %j no es un monto", (amount) => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === "monto" ? [k, amount] : [k, v]))))?.amount).toBeNull();
  });

  it.each(["", "no-es-uuid", "AAAAAAAA-2222-4333-8444-555555555555", `${DOC}x`])("el texto %j no es un texto", (document) => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === "texto" ? [k, document] : [k, v]))))?.document).toBeNull();
  });

  it("un campo repetido no vale: ni el plan ni la casilla", () => {
    expect(readPlansForm(form([...FULL, ["plan", "annual"]]))?.plan).toBeNull();
    expect(readPlansForm(form([...FULL, ["acepto", "on"]]))?.accepted).toBe(false);
  });

  it("la casilla vale solo con su valor", () => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === "acepto" ? [k, "true"] : [k, v]))))?.accepted).toBe(false);
    expect(readPlansForm(form(FULL.filter(([k]) => k !== "acepto")))?.accepted).toBe(false);
  });

  it("sin destino, nulo", () => {
    expect(readPlansForm(form(FULL.filter(([k]) => k !== "volver")))?.returnTo).toBeNull();
  });
});

describe("PA-04, lo que se dice con cada respuesta", () => {
  it.each([
    [{ kind: "has_access" }, "has_access"],
    [{ kind: "in_progress" }, "in_progress"],
    [{ kind: "changed" }, "changed"],
    [{ kind: "unavailable" }, "unavailable"],
    [{ kind: "invalid" }, "invalid"],
    [{ kind: "not_allowed", reason: "email_unverified" }, "email_unverified"],
    [{ kind: "not_allowed", reason: "suspended" }, "suspended"],
    [{ kind: "not_allowed", reason: "no_actor" }, "unavailable"],
  ] as const)("%j se dice %s", (answer, said) => {
    expect(plansAnswerOf(answer)).toBe(said);
  });
});

describe("PA-04, cifras y direcciones", () => {
  it("el precio es el total en pesos, con sus centavos", () => {
    expect(priceText(34900)).toBe("$349.00");
    expect(priceText(349000)).toBe("$3,490.00");
  });

  it("lo que equivale al mes del anual se redondea hacia arriba al centavo: nunca se anuncia menos que lo real", () => {
    // Cambió por el requisito (decisión de Sergio del 2026-11-12, T-616, solicitud 4b): antes era hacia abajo.
    // Todo en centavos, y al centavo: nunca al peso.
    // $2,990.00 al año son 249.1666 pesos al mes: $249.17 (el caso de Sergio, la semilla).
    expect(monthlyEquivalent(299000)).toBe(24917);
    // $29.90 al año son 249.1666 centavos: suben a 250 centavos, $2.50.
    expect(monthlyEquivalent(2990)).toBe(250);
    // $3,490.00 al año: $290.84 (hacia abajo eran $290.83).
    expect(monthlyEquivalent(349000)).toBe(29084);
    // Exacto, no sube: $1,200.00 al año son $100.00 al mes.
    expect(monthlyEquivalent(120000)).toBe(10000);
    expect(monthlyEquivalent(12)).toBe(1);
    // Los bordes: cero da cero, y un total grande sigue al centavo ($99,999,999.99 al año).
    expect(monthlyEquivalent(0)).toBe(0);
    expect(monthlyEquivalent(9_999_999_999)).toBe(833_333_334);
  });

  it("la dirección lleva el plan y el destino solo si los hay", () => {
    expect(plansHref(null, null)).toBe("/planes");
    expect(plansHref("annual", null)).toBe("/planes?plan=annual");
    expect(plansHref("monthly", "/cursos/uno?x=1")).toBe("/planes?plan=monthly&volver=%2Fcursos%2Funo%3Fx%3D1");
  });

  it("PA-32 lleva la sesión", () => {
    expect(confirmingHref("cs_test_abc")).toBe("/suscripcion/confirmando?sesion=cs_test_abc");
  });

  it("de la dirección: el plan si existe, el destino que la lista admite, y si se volvió sin pagar", () => {
    const resolve = (input: string) => (input.startsWith("/cursos/") ? input : null);
    expect(readPlansQuery({ plan: "annual", volver: "/cursos/uno", cancelado: "1" }, resolve)).toEqual({ plan: "annual", returnTo: "/cursos/uno", canceled: true });
    expect(readPlansQuery({ plan: "weekly", volver: "https://otro.example", cancelado: "si" }, resolve)).toEqual({ plan: null, returnTo: null, canceled: false });
    expect(readPlansQuery({ plan: ["monthly", "annual"] }, resolve)).toEqual({ plan: null, returnTo: null, canceled: false });
  });

  it("si los planes no se pueden mostrar, el visitante que iba a otro lado va a entrar con su destino; los demás se quedan", () => {
    expect(closedPlansDetour("visitor", "/cursos/uno/lecciones/a")).toBe("/cursos/uno/lecciones/a");
    expect(closedPlansDetour("visitor", null)).toBeNull();
    expect(closedPlansDetour("student", "/cursos/uno/lecciones/a")).toBeNull();
    expect(closedPlansDetour("unknown", "/cursos/uno/lecciones/a")).toBeNull();
  });

  it("los planes no son destino de sí mismos", () => {
    const all = (input: string) => input;
    expect(readPlansQuery({ volver: "/planes" }, all).returnTo).toBeNull();
    expect(readPlansQuery({ volver: "/planes?plan=annual" }, all).returnTo).toBeNull();
    expect(readPlansQuery({ volver: "/planes/algo" }, all).returnTo).toBeNull();
    expect(readPlansQuery({ volver: "/planes-de-estudio" }, all).returnTo).toBe("/planes-de-estudio");
  });
});

// T-616, 3b-4: lo que ahorra el anual contra doce meses del mensual, en pesos enteros y hacia abajo (decisión de Sergio del
// 2026-11-12): nunca se anuncia más de lo que se ahorra. De menos de un peso, o si no ahorra, nada.
describe("PA-04, lo que ahorra el anual", () => {
  it("con los precios de la semilla: 12 × $349.00 − $2,990.00 son $1,198", () => {
    expect(annualSaving(34900, 299000)).toBe(1198);
    expect(savingText(1198)).toBe("$1,198");
  });

  it("sale de los montos, no de una cifra escrita: otro par da otra cifra", () => {
    // 12 × $399.00 − $3,990.00 = $798.
    expect(annualSaving(39900, 399000)).toBe(798);
    expect(savingText(798)).toBe("$798");
  });

  it("hacia abajo al peso, también donde el redondeo al más cercano subiría", () => {
    // 418 800 − 298 901 = 119 899 centavos: $1,198.99 se anuncia $1,198, no $1,199.
    expect(annualSaving(34900, 298901)).toBe(1198);
    // 99 centavos de ahorro: menos de un peso, nada.
    expect(annualSaving(34900, 418701)).toBeNull();
    // Justo un peso.
    expect(annualSaving(34900, 418700)).toBe(1);
  });

  it("si el anual cuesta lo mismo o más que doce meses, no hay ahorro", () => {
    expect(annualSaving(34900, 418800)).toBeNull();
    expect(annualSaving(34900, 500000)).toBeNull();
  });

  it("de montos que no son enteros positivos y seguros de centavos, nada", () => {
    for (const [monthly, annual] of [
      [0, 299000],
      [34900, 0],
      [-34900, 299000],
      [34900, -1],
      [349.5, 299000],
      [34900, 2990.5],
      [Number.NaN, 299000],
      [34900, Number.POSITIVE_INFINITY],
      [Number.MAX_SAFE_INTEGER, 299000],
    ])
      expect(annualSaving(monthly as number, annual as number), `${monthly} y ${annual}`).toBeNull();
  });

  it("la cifra nunca pasa del ahorro real ni se queda un peso o más abajo (propiedad)", () => {
    const cents = fc.integer({ min: 1, max: 999_999_999_999 });
    fc.assert(
      fc.property(cents, cents, (monthly, annual) => {
        const real = 12 * monthly - annual;
        const pesos = annualSaving(monthly, annual);
        if (real < 100) return pesos === null;
        return pesos !== null && Number.isInteger(pesos) && pesos * 100 <= real && real < pesos * 100 + 100;
      }),
    );
  });

  it("el texto de la cifra es el entero que recibe, sin centavos ni redondeo; siete cifras caben con sus comas", () => {
    expect(savingText(1)).toBe("$1");
    expect(savingText(1234567)).toBe("$1,234,567");
    fc.assert(fc.property(fc.integer({ min: 1, max: 99_999_999 }), (pesos) => savingText(pesos).replace(/[$,]/g, "") === String(pesos)));
  });
});
