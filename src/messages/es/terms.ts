// El bloque de términos (diseño, sección 8.5). Las palabras que pueden cambiar por una
// decisión de marca existen aquí una sola vez, en cada forma en que se usan. Los demás
// textos las citan con un marcador: «Sobre {el_maestro}», «Cursos de {maestros}».
//
// Cambiar «maestro» por otra palabra es cambiar este bloque y nada más (PQ-14). Una prueba
// lo demuestra (catalog.test.ts) y otra impide que un texto escriba la palabra a mano.
//
// Lo que este bloque no resuelve, y se decide aparte: las direcciones públicas que llevan
// la palabra, y el género (la Plataforma no guarda el de nadie).
export const terms = {
  // El nombre del producto, con su artículo. Provisional mientras no haya marca (PQ-13).
  Plataforma: "La Plataforma",

  maestro: "maestro",
  maestros: "maestros",
  Maestro: "Maestro",
  Maestros: "Maestros",
  el_maestro: "el maestro",
  El_maestro: "El maestro",
  los_maestros: "los maestros",
  Los_maestros: "Los maestros",
  // Con las contracciones, para que el texto no tenga que saber el género del artículo.
  del_maestro: "del maestro",
  al_maestro: "al maestro",
  un_maestro: "un maestro",
} as const;
