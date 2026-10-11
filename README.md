# Plataforma · código

El código de la plataforma de cursos por suscripción.

**Estado al 2026-10-11:** cimientos, y las primeras pantallas. En `main` están la portada
provisional y las de entrada de la cuenta (entrar, completar la cuenta y un inicio
provisional); las de registro, verificación y recuperación están propuestas en la
solicitud 14. Lo que hay:

- **Esqueleto** (T-101): aplicación Next.js, las capas del TRD con el lint que las hace
  cumplir, la prueba de capas, el escaneo de secretos y la integración continua.
- **Entornos** (T-102, a medias): variables validadas al arrancar, Supabase en local, un
  entorno de pruebas remoto, y el registro de errores con Sentry, que solo recibe errores
  y sin datos personales. Falta producción.
- **Base inicial** (T-103): identidad, parámetros de negocio con vigencia y auditoría.
  Cinco tablas con sus pruebas de base.
- **Acceso a la base** (T-104, primera entrega): el adaptador de `src/adapters/supabase/`,
  único camino del código a la base.
- **Cuenta** (T-104, segunda entrega): los textos legales y los consentimientos,
  el freno de entrada, las reglas puras de registro, entrada y recuperación, la sesión por
  cookie y los servicios: la guarda de sesión, entrar y salir, y registrarse (por
  invitación del servidor), recuperar la contraseña y completar la cuenta. Las pantallas
  van en dos solicitudes. La primera (solicitud 13, en `main`): entrar (`/entrar`),
  completar la cuenta (`/consentimientos`), la cuenta suspendida, un inicio provisional
  (`/inicio`), los textos legales en versión mínima (`/legal/[documento]`), la guarda en
  cada página, la redirección del paso previo y las pruebas de extremo a extremo con
  Playwright. La segunda (solicitud 14, propuesta): registro (`/registro`), verificación
  del correo (`/verificar` y `/verificar/[token]`) y recuperación de la contraseña
  (`/recuperar` y `/recuperar/[token]`). Con ella termina la entrega.
- **Diseño** (T-109): el catálogo de textos, los tokens y los componentes base.

Lo que está en revisión y lo que sigue lo dice `../PROGRESO.md`.

## Cómo se arranca

Hace falta Node 22.12 o superior (se usa la 24), pnpm 10 y, para la base local, Docker
Desktop abierto.

```bash
pnpm install
pnpm db:start   # Supabase en local
pnpm db:login   # una vez por base: le da entrada a la aplicación
pnpm dev        # http://localhost:3000
```

Antes hay que copiar `.env.example` a `.env.local` y llenarlo: el archivo dice de dónde
sale cada valor. Los demás comandos y las reglas de trabajo están en `CLAUDE.md`.

Con `pnpm dev`, `http://localhost:3000/muestra` enseña los componentes base. Esa página no
existe en producción.

Las pruebas de extremo a extremo corren con `pnpm test:e2e`. Necesitan la pila local arriba
y lista (`pnpm db:start`, `pnpm db:login` y `pnpm db:drafts`), el puerto 3000 libre (sin un
`pnpm dev` corriendo: Playwright compila la aplicación y la sirve ahí él mismo) y Chromium
instalado una vez (`pnpm exec playwright install chromium`).

## Cómo está ordenado

Las capas y lo que cada una puede importar están en `CLAUDE.md`. Lo que llegó con las
pantallas de la cuenta:

- `src/app/_lib/`: lo que comparten todas las pantallas. El único archivo que lee la
  petición (`request-context.ts`) y la guarda que llama cada página (`guard.ts`).
- `src/app/(cuenta)/`: las pantallas de la cuenta. Cada una con su página, su formulario,
  su acción de servidor y la tabla pura que decide qué hace (`outcomes.ts`).
- `tests/e2e/`: las pruebas de extremo a extremo (`*.spec.ts`).

Tres reglas para quien escriba una pantalla. Dos las exige una prueba de arquitectura: toda
página llama a la guarda o entra a la lista de públicas, y toda ruta y toda acción de
servidor entra a su lista. La tercera la prueba el extremo a extremo: los formularios
funcionan sin JavaScript. Las demás están en `CLAUDE.md`.

## Dónde está la documentación

Este repositorio vive anidado dentro del proyecto de documentación. La planeación está en
la carpeta de arriba y no se copia aquí, para que haya una sola versión:

- `../INDICE.md`: qué hay en cada documento y sección. Se lee primero.
- `../planeacion/`: PRD, TRD, diseño, flujo, esquema de backend y plan de implementación.

Si este repositorio se clona solo, sin la carpeta de arriba, la documentación no viene.
Quien vaya a trabajar en él necesita además el PDF de los documentos, que se genera con
`python planeacion/exportar.py` desde el proyecto de documentación.

## Cómo entra un cambio

`main` está protegida: todo entra por solicitud de cambio, con la integración continua en
verde. Las zonas delicadas (control de acceso, cobro, reparto, migraciones) no se fusionan
sin que una persona las lea línea por línea: están en `.github/CODEOWNERS`.

**`main` no se despliega todavía.** En Vercel `main` es producción, y producción aún no
tiene variables de entorno ni base: `vercel.json` apaga su despliegue automático. Las demás
ramas siguen generando su vista previa, que es el entorno de pruebas. Cuando producción
exista (dominio, cuentas reales y sus variables), se quita esa línea de `vercel.json` en la
misma solicitud que la da de alta.

El orden de las tareas es el de `../planeacion/06-plan-implementacion.md`.
