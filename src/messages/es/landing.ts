import { defineMessages } from "../format";

// Los textos de la portada pública (PA-01; T-614, parte 2) y de su barra y su pie.
//
// Lo que todavía no existe no se promete (decisiones de Sergio del 2026-11-05): sin la pantalla de
// planes ni la suscripción, el botón dice «Crear cuenta» y lleva al registro, y no hay precio ni
// preguntas frecuentes; sin constancias (T-504), «Cómo funciona» no las menciona. Planes, Para
// maestros y Ayuda entran a la barra y al pie cuando existan sus pantallas.
export const landing = defineMessages({
  header: {
    label: "Principal",
    signIn: "Entrar",
    signUp: "Crear cuenta",
  },
  hero: {
    title: "Aprende con quienes practican lo que enseñan",
    lead: "Cursos en video para cuidar el cuerpo y la mente. Un precio, todo el catálogo.",
    signUp: "Crear cuenta",
    openCourse: "Empieza con el curso abierto",
    haveAccount: "¿Ya tienes cuenta?",
    signIn: "Entrar",
  },
  sample: {
    title: "Una muestra del catálogo",
  },
  openCourse: {
    label: "Curso abierto",
    lead: "Mira un curso completo sin pagar. Solo necesitas crear tu cuenta.",
    action: "Ver el curso abierto",
  },
  teachers: {
    title: "Quienes enseñan",
  },
  how: {
    title: "Cómo funciona",
    catalog: {
      title: "Un precio, todo el catálogo",
      body: "Con tu suscripción ves todos los cursos, sin pagar uno por uno.",
    },
    lessons: {
      title: "Lecciones cortas",
      body: "Cada lección cabe en un rato de tu día.",
    },
    pace: {
      title: "A tu ritmo",
      body: "Tu avance se guarda en cada lección, y retomas donde te quedaste.",
    },
  },
  empty: "Estamos preparando los primeros cursos.",
  unavailable: "No pudimos cargar los cursos. Inténtalo de nuevo en un momento.",
  footer: {
    label: "Textos legales",
    terms: "Términos y condiciones",
    privacy: "Aviso de privacidad",
  },
});
