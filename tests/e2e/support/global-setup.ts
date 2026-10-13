import { removeLeftovers } from "./stack";

// Antes de la primera prueba, y después de la última: nada de lo que hacen debe quedar en
// la base. Que todo lo que tocan es la pila local ya lo comprobó `playwright.config.ts`,
// antes de levantar la aplicación.
export default async function setup(): Promise<() => Promise<void>> {
  // Lo que haya dejado una corrida que se cortó a la mitad. Si aquí falla porque una persona
  // de prueba tiene capacidades, quedó el residuo de las pruebas del equipo: `pnpm db:reset`.
  await removeLeftovers();
  // Las del equipo son la excepción, y por eso corren aparte: dejan personas con capacidades
  // y renglones en la auditoría, que no se pueden borrar. Después de ellas la base se rehace
  // entera (`scripts/e2e-equipo.mjs`), así que aquí no se intenta limpiar.
  if (process.env.E2E_EQUIPO === "1") return () => Promise.resolve();
  return removeLeftovers;
}
