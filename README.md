# Plataforma · código

El código de la plataforma de cursos por suscripción.

**Estado al 2026-10-08:** cimientos. Todavía no hay ninguna pantalla más que la portada
provisional. Lo que sí hay:

- **Esqueleto** (T-101): aplicación Next.js, las capas del TRD con el lint que las hace
  cumplir, la prueba de capas, el escaneo de secretos y la integración continua.
- **Entornos** (T-102, a medias): variables validadas al arrancar, Supabase en local, y un
  entorno de pruebas remoto. Faltan el registro de errores y producción.
- **Base inicial** (T-103): identidad, parámetros de negocio con vigencia y auditoría.
  Cinco tablas con sus pruebas de base.
- **Acceso a la base** (T-104, primera entrega): el adaptador de `src/adapters/supabase/`,
  único camino del código a la base.
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
verde. Empujar a `main` despliega a producción en Vercel. Las zonas delicadas (control de
acceso, cobro, reparto, migraciones) no se fusionan sin que una persona las lea línea por
línea: están en `.github/CODEOWNERS`.

El orden de las tareas es el de `../planeacion/06-plan-implementacion.md`.
