import { removeLeftovers } from "./stack";

// Antes de la primera prueba, y después de la última: nada de lo que hacen debe quedar en
// la base. Que todo lo que tocan es la pila local ya lo comprobó `playwright.config.ts`,
// antes de levantar la aplicación.
export default async function setup(): Promise<() => Promise<void>> {
  // Lo que haya dejado una corrida que se cortó a la mitad.
  await removeLeftovers();
  return removeLeftovers;
}
