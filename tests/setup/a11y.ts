import axe from "axe-core";

// Las reglas automáticas de accesibilidad (RNF-09), para las pruebas de componentes.
//
// Dos reglas no se pueden revisar aquí y van apagadas:
//   - `color-contrast`: el DOM simulado no aplica CSS. Los contrastes se recalculan desde
//     los tokens en tests/design/contrast.test.ts.
//   - `region`: pide que todo viva dentro de una región de la página, y un componente
//     suelto no tiene página alrededor.
//
// Lo que tampoco ve un DOM simulado (foco visible, tamaños táctiles, 320 px de ancho) se
// revisa en la página de muestra y, con las pantallas, en un navegador real.
const options: axe.RunOptions = {
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
};

/** Las faltas de accesibilidad de un trozo de pantalla. Vacío si no hay ninguna. */
export async function a11yViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, options);
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
  );
}
