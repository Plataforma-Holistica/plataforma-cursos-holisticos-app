// Lo que la pantalla de los datos fiscales necesita saber de las reglas, para el navegador: `src/app/` no importa el dominio (T-409).

export { TAX_REGIMES } from "@/domain/fiscal/regime";
export { LEGAL_NAME_MAX_LENGTH, type TaxFormField, type TaxFormProblem, type TaxFormProblems } from "@/domain/fiscal/tax-form";
