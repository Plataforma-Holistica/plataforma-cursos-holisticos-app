# Plataforma · código

El código de la plataforma de cursos por suscripción. Repositorio propio y privado.

**Estado:** esqueleto (tarea T-101, 2026-10-06). Hay una aplicación Next.js con una sola
página, las capas del TRD con el lint que las hace cumplir, la prueba de capas, el escaneo
de secretos y la integración continua. Todavía no hay base de datos ni funciones.

## Cómo se arranca

Hace falta Node 22.12 o superior (se usa la 24) y pnpm 10.

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

Los demás comandos y las reglas de trabajo están en `CLAUDE.md`.

## Dónde está la documentación

Este repositorio vive anidado dentro del proyecto de documentación. La planeación está en
la carpeta de arriba y no se copia aquí, para que haya una sola versión:

- `../INDICE.md`: qué hay en cada documento y sección. Se lee primero.
- `../planeacion/`: PRD, TRD, diseño, flujo, esquema de backend y plan de implementación.

Si este repositorio se clona solo, sin la carpeta de arriba, la documentación no viene.
Quien vaya a trabajar en él necesita además el PDF de los documentos, que se genera con
`python planeacion/exportar.py` desde el proyecto de documentación.

## Qué sigue

El orden es el de `../planeacion/06-plan-implementacion.md`:

1. **T-109**: archivo único de textos, tokens y componentes base del diseño.
2. **T-102**: entornos y variables validadas al arrancar. La base local necesita Docker, y
   el entorno de pruebas necesita las cuentas de los servicios (T-003).
3. Después, tramo por tramo.

## Pendiente de este repositorio

- Remoto: crear el repositorio privado en GitHub y conectarlo (T-006). La integración
  continua no corre hasta entonces.
- Proyecto propio en Vercel, distinto del que publica la documentación.
- **`main` no se despliega todavía.** En Vercel `main` es producción, y producción aún no
  tiene variables de entorno ni base: `vercel.json` apaga su despliegue automático
  (`git.deploymentEnabled`). Las demás ramas siguen generando su vista previa, que es el
  entorno de pruebas. Cuando producción exista (dominio, cuentas reales y sus variables),
  se quita esa línea de `vercel.json` en la misma solicitud que la da de alta.
