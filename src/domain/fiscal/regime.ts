import type { PayeeKind } from "./rfc";

// Los regímenes fiscales: `c_RegimenFiscal` del catálogo del SAT (`catCFDI_V_4_20261029`), con los tipos de persona de sus celdas,
// leído el 2026-10-31. No se valida contra `catCFDI.xsd`, que acepta claves sin nombre en el catálogo. Sus nombres van en los textos.

export const TAX_REGIMES = [
  { code: "601", person: false, company: true },
  { code: "603", person: false, company: true },
  { code: "605", person: true, company: false },
  { code: "606", person: true, company: false },
  { code: "607", person: true, company: false },
  { code: "608", person: true, company: false },
  { code: "610", person: true, company: true },
  { code: "611", person: true, company: false },
  { code: "612", person: true, company: false },
  { code: "614", person: true, company: false },
  { code: "615", person: true, company: false },
  { code: "616", person: true, company: false },
  { code: "620", person: false, company: true },
  { code: "621", person: true, company: false },
  { code: "622", person: false, company: true },
  { code: "623", person: false, company: true },
  { code: "624", person: false, company: true },
  { code: "625", person: true, company: false },
  { code: "626", person: true, company: true },
] as const;

export type TaxRegime = (typeof TAX_REGIMES)[number]["code"];

/** Una clave del catálogo, o nulo. */
export function taxRegimeOf(value: unknown): TaxRegime | null {
  return TAX_REGIMES.find((regime) => regime.code === value)?.code ?? null;
}

/** ¿Ese régimen aplica a ese tipo de persona? */
export function acceptsPayee(code: TaxRegime, payee: PayeeKind): boolean {
  return TAX_REGIMES.some((regime) => regime.code === code && regime[payee]);
}
