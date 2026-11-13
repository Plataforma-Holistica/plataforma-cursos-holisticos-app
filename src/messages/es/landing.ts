import { defineMessages } from "../format";

// Los textos de la portada pública (PA-01; T-614, parte 2) y de su barra y su pie.
//
// Lo que todavía no existe no se promete (decisiones de Sergio del 2026-11-05): no hay preguntas frecuentes,
// y sin constancias (T-504) «Cómo funciona» no las menciona. Desde T-616 (solicitud 4; pedidos de Sergio del
// 2026-11-11 y 12: los planes antes de crear cuenta) la barra y el pie enlazan a los planes, la portada lleva
// sus precios en su sección, y con planes a la venta el botón del encabezado dice «Suscribirme». Ninguna cifra
// se escribe aquí: las pone la base. Para maestros y Ayuda entran cuando existan sus pantallas.
export const landing = defineMessages({
  header: {
    label: "Principal",
    plans: "Planes",
    signIn: "Entrar",
    signUp: "Crear cuenta",
  },
  hero: {
    title: "Aprende con quienes practican lo que enseñan",
    lead: "Cursos en video de prácticas para cuidar el cuerpo y la mente.",
    signUp: "Crear cuenta",
    subscribe: "Suscribirme",
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
  plans: {
    title: "Planes",
    seeAll: "Ver planes",
  },
  how: {
    title: "Cómo funciona",
    catalog: {
      title: "Cursos completos",
      body: "Cada curso va de principio a fin, en lecciones que siguen un orden.",
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
    label: "Enlaces del sitio",
    plans: "Planes",
    terms: "Términos y condiciones",
    privacy: "Aviso de privacidad",
  },
});
