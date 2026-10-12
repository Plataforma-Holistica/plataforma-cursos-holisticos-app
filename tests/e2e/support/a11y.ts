import { createRequire } from "node:module";

import type { Page } from "@playwright/test";

// Las reglas automáticas de accesibilidad (RNF-09), en un navegador de verdad. Es el mismo
// motor de las pruebas de componentes (`tests/setup/a11y.ts`), pero aquí sí hay hoja de
// estilos y página alrededor: entran el contraste y las regiones, que allá van apagados.
//
// No sustituye la revisión con teclado y con lector de pantalla (TRD §12.1).

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

interface AxeResults {
  violations: { id: string; help: string; nodes: { target: string[] }[] }[];
}

/** Las faltas de accesibilidad de la pantalla que está a la vista. Vacío si no hay ninguna. */
export async function a11yViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath });
  const results = await page.evaluate(async () => {
    // A media transición un color no es el de ningún estado: un botón que vuelve de
    // «cargando» pasa un instante por un contraste que no existe ni antes ni después. Se
    // mide cuando las transiciones en curso terminaron. Las animaciones no se esperan: un
    // indicador de carga no termina nunca.
    const transitions = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
    await Promise.all(transitions.map((transition) => transition.finished.catch(() => undefined)));
    const engine = (window as unknown as { axe: { run: (context: Document) => Promise<AxeResults> } }).axe;
    return engine.run(document);
  });
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
  );
}
