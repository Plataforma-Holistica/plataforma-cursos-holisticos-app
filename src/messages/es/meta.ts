import { defineMessages } from "../format";

// Lo que va en la pestaña del navegador. Cada pantalla pone su nombre y el armazón le
// agrega el del producto (diseño, sección 6: «{Pantalla} · {Plataforma}»).
export const meta = defineMessages({
  titleTemplate: "{page} · {Plataforma}",
  titleDefault: "{Plataforma}",
});
