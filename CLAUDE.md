# CLAUDE.md

Guía para trabajar en el código de la Plataforma. Sale de
`../planeacion/09-guia-agente.md`: si esta guía y los documentos de planeación chocan,
mandan ellos y esta guía se corrige.

## Qué es este repositorio

La Plataforma: cursos en video por suscripción, donde una parte del ingreso (el bote) se
reparte entre los maestros según lo que vio cada alumno. Una sola aplicación Next.js con
cuatro superficies: sitio público, área del alumno, portal del maestro y administración.

Es un repositorio propio, anidado dentro del proyecto de documentación. La carpeta de
arriba tiene la planeación y no se versiona aquí; este repositorio no se versiona allá.
Conviene abrir la sesión desde la carpeta de arriba, para tener los dos a la mano.

La documentación manda sobre el código:

| Necesitas saber | Lee |
|---|---|
| Dónde está cada cosa | `../INDICE.md`, siempre primero |
| Qué debe hacer una función y cómo se prueba | `../planeacion/01-prd.md` §5 (requisitos `RF`) y §6 (reglas `RN`) |
| Con qué pieza y en qué capa | `../planeacion/02-trd.md` |
| Cómo se ve una pantalla | `../planeacion/03-diseno-ui-ux.md`, por su `PA` |
| Por dónde pasa el usuario | `../planeacion/04-flujo-app.md`, por su `FL` |
| Qué tabla, qué política | `../planeacion/05-esquema-backend.md` |
| Qué tarea sigue y cómo se verifica | `../planeacion/06-plan-implementacion.md`, por su `T` |
| Cuánto vale una cifra de negocio | `../planeacion/00-fundamentos.md` §4 |

No leas todo: varios documentos pasan de 3 000 líneas. Lee el índice y la sección que toca.

## Antes de escribir código

1. Ubica la tarea (`T-000`) en el plan y los requisitos que atiende.
2. Lee los criterios de aceptación de esos requisitos. Son la definición de «funciona».
3. Contrasta contra el PRD las secciones del TRD, del esquema y del diseño que la tarea
   toca: se escribieron en paralelo y el PRD es el que manda.
4. Si la tarea toca una de las tres zonas delicadas (abajo), detente y sigue su regla.
5. Si el requisito es ambiguo o choca con otro documento, pregunta. No inventes la regla.

## Comandos

El gestor de paquetes es pnpm. Solo están aquí los comandos que ya existen; los de extremo
a extremo, de Payload y de trabajos llegan con la tarea que los crea, y se escriben aquí
ese mismo día.

```bash
pnpm install     # instala y activa el gancho de commit (.githooks/)
pnpm dev         # aplicación en local, en http://localhost:3000
pnpm typecheck   # tipos
pnpm lint        # lint, incluida la regla de capas
pnpm test        # pruebas del dominio y la prueba de capas, sin red ni base
pnpm secrets     # escaneo de secretos en todo el repositorio
pnpm build       # compilación de producción
pnpm db:start    # levanta Supabase en local (necesita Docker Desktop abierto)
pnpm db:status   # direcciones y llaves locales, las que pide .env.example
pnpm db:stop     # lo apaga; los datos se conservan
pnpm db:reset    # borra la base local y la rehace: migraciones, semilla y db:login
pnpm db:login    # le da a app_service entrada a la base local (ver .env.example)
pnpm db:migration <nombre>   # crea una migración vacía en supabase/migrations/
pnpm test:db     # pruebas de base (pgTAP) de supabase/tests/, contra la base local
pnpm test:int    # pruebas de integración de tests/integration/, contra la base local
```

Antes de dar una tarea por terminada corren, en este orden: `typecheck`, `lint`, `test` y
las pruebas de la capa que se tocó. Si se tocó la base: `db:reset` y `test:db`. Si se tocó
un adaptador o un servicio que llega a la base: `test:int`, y después `test:db` otra vez,
para comprobar que no dejó residuo. La integración continua (`.github/workflows/ci.yml`)
corre lo mismo más `secrets`, la auditoría de dependencias y `build`.

`pnpm db:login` hace falta una vez por base: la migración crea a `app_service` sin permiso
de entrada, y ese guion se lo da con la contraseña de `DATABASE_URL`. Solo corre contra la
base local. `db:reset` lo repite, porque rehacer la base borra los roles.

Versiones que no se suben sin revisar:

- **Next.js 16.3**: Payload 3 exige 16.3.3 o superior. Esta versión cambió respecto a las
  anteriores: su documentación exacta está en `node_modules/next/dist/docs/`, y se lee
  antes de usar una API de Next.
- **TypeScript 6.0**: el lint de TypeScript todavía no admite la 7.
- **ESLint 9**: los plugins que trae `eslint-config-next` fallan con la 10. La 9 ya no
  recibe correcciones, así que se sube en cuanto esos plugins lo permitan.

## Estructura y capas

La que fija el TRD §4.2.

| Carpeta | Qué va | Puede importar | No puede |
|---|---|---|---|
| `src/domain/` | Reglas de negocio puras: acceso, progreso, consumo, reparto | Nada fuera de sí misma | Red, base, reloj, variables de entorno |
| `src/adapters/` | Un adaptador por proveedor | El SDK de ese proveedor y tipos del dominio | Otros adaptadores, pantallas |
| `src/services/` | Casos de uso: cargan datos, llaman al dominio, guardan | Dominio y adaptadores. A la base llegan por `src/adapters/supabase/` | Componentes de React, el cliente de base y el SDK de Supabase |
| `src/app/` | Rutas, acciones de servidor, páginas | Servicios | Cliente de base, SDK de proveedores, dominio de reparto |
| `src/jobs/` | Trabajos programados y por evento | Servicios | Lo mismo que `src/app/` |
| `src/payload/` | Configuración de Payload: solo el catálogo | Ganchos que llaman a servicios | Tablas de dinero, de consumo o de personas |
| `src/messages/` | Los textos visibles, en un solo archivo | Nada | Todo lo demás |
| `src/config/` | Las variables de entorno, leídas y validadas en un solo lugar | Nada de la aplicación | Todo lo demás |
| `supabase/migrations/` | El esquema propio, en SQL | | Objetos del esquema de Payload |
| `supabase/tests/` | Pruebas de base en pgTAP: qué lee, qué escribe y qué se le niega a cada rol | `_ayuda.psql`, con `\ir` | |
| `supabase/seeds/` | Valores de arranque de los parámetros, transcritos de `00-fundamentos.md` §4 | | Cifras que no estén en ese documento |
| `tests/integration/` | Pruebas del código contra la base local real, con personas dadas de alta en el Auth local | Adaptadores y servicios | Dejar residuo: lo que escribe en una tabla auditada se revierte |
| `scripts/` | Guiones de desarrollo y de la integración continua | | Correr contra una base que no sea la local |

Las reglas viven en `eslint.config.mjs` (con `eslint-plugin-boundaries`) y rompen el lint.
`tests/architecture/layers.test.ts` comprueba cada una: si se afloja una regla, esa prueba
falla. Cinco precisiones que la tabla no dice:

- **`process.env` solo se lee en `src/config/`.** El resto llama a `getEnv()`. Adaptadores
  y servicios pueden importar la configuración; el dominio, `src/app/` y `src/jobs/`, no.
  `src/instrumentation.ts`, el arranque de Next, la valida antes de la primera petición y
  termina el proceso si falta una variable. Una variable nueva se agrega al esquema de
  `src/config/env.ts` y a `.env.example` en el mismo cambio.
- **`src/app/` y `src/jobs/` importan solo servicios** (y `src/app/`, además, los textos).
  Es la lectura estricta del TRD: si una pantalla necesita un tipo del dominio, el
  servicio lo reexporta.
- **Un adaptador vive en su carpeta**, `src/adapters/<proveedor>/`, y no importa de otra.
- **Un archivo de `src/` fuera de estas carpetas es un error de lint.** Una carpeta nueva
  se declara primero en `eslint.config.mjs`, con su regla y su caso en la prueba.
- **El cliente de base (`pg`) y el SDK de Supabase solo se importan en
  `src/adapters/supabase/`** (ADR-31, TRD §8.10). La aplicación entra a la base como
  `app_service`, que salta la seguridad por fila: por eso el resto llega con las tres
  funciones de `db.ts`, y siempre declara por quién actúa.
  - `asUser(claims, fn)`: lo que una persona lee o escribe por sí misma. La base filtra
    por ella. Solo acepta las claims que devolvió `verifyAccessToken`, y solo mientras su
    token no haya vencido.
  - `asServer({ claims, reason, requestId }, fn)`: una escritura que depende de una
    validación, a nombre de quien la pidió. Quién actúa y con qué nivel salen de esas
    mismas claims verificadas: no se declaran a mano, porque este camino salta la
    seguridad por fila.
  - `asSystem(contexto, fn)`: un trabajo sin persona con sesión detrás (un aviso de cobro,
    un cierre).

  `verifyAccessToken` devuelve `null` si el token no es válido y lanza
  `IdentityUnavailableError` si no se pudo saber: no es lo mismo, y a la persona no se le
  trata como si no tuviera sesión. Las claves públicas las pide y las recuerda el propio
  adaptador (`keys.ts`): un token mal hecho no sale a la red ni pasa por una caída.

  Toda consulta se escribe con la etiqueta `sql`, que manda los valores como parámetros,
  y cada fila se valida con su esquema Zod. **Nunca se arma SQL pegando texto**: dentro de
  `asUser` un `reset role` recuperaría el salto de la seguridad por fila. La etiqueta lo
  dificulta, no lo impide: `sql` se puede imitar, y por eso el lint prohíbe además
  llamarla como función. Cuatro cosas que el adaptador rechaza al correr:
  - una consulta con dos sentencias, con `commit`, `rollback`, `end` o `abort` (también
    `and chain`), o que cambie de rol (`set role`, `reset role`): quien abre la
    transacción, la cierra y decide su rol es el adaptador. El lint lo dice antes, al
    escribirla;
  - anidar una función dentro de otra: cada una toma una conexión. Se pasa el `tx`;
  - usar el `tx` después de que su función terminó;
  - **atrapar un error de la base y seguir.** La transacción ya está abortada y nada se
    guarda: el adaptador lanza `TransactionAbortedError` en vez de reportar éxito. Un
    error esperado (un duplicado) se evita con la consulta (`on conflict`), no con un
    `catch`.

En la base, cuatro reglas que salen de `../planeacion/05-esquema-backend.md` §16.1:

- **Una tabla llega completa en su migración**: seguridad por fila, permisos, políticas,
  sus guardianes y su disparador de auditoría si es administrativa. Sin política, una
  tabla queda cerrada.
- **Ningún permiso por omisión.** `anon`, `authenticated` y `service_role` no reciben nada
  que la migración no conceda a mano. `private.schema_violations()` debe devolver cero
  filas, y `supabase/tests/01_estructura.test.sql` lo exige.
- **Una persona con sesión casi no escribe.** Lo que depende de una validación va por el
  servidor (`app_service`), que declara en la transacción por quién actúa
  (`app.actor_id`, `app.actor_aal`) o que es el sistema (`app.actor_kind`).
- **La prueba primero**, en `supabase/tests/`, y se la ve fallar antes de escribir la
  migración. Las migraciones se aplican solo en la base local.

Los archivos de `tests/architecture/fixtures/` violan las capas a propósito: son las
muestras de esa prueba y no son código de la aplicación.

## Las tres zonas que se escriben despacio

Un error aquí cuesta dinero o expone contenido. En las tres:

- la prueba se escribe antes que el código;
- ningún cambio se fusiona sin que una persona lo lea línea por línea;
- el agente **propone y se detiene**: no fusiona, no despliega y no aplica migraciones a
  una base remota. En la base local sí las aplica, las veces que haga falta, porque sin
  eso no puede escribir la prueba antes que el código (decisión del 2026-10-06).

| Zona | Qué protege |
|---|---|
| Avisos de cobro | Que nadie tenga acceso sin pagar y que un cobro se registre una sola vez |
| Control de acceso | Que nadie sin acceso reproduzca un video ni lea datos de otro |
| Reparto, consolidación, cierre y toda migración que toque un libro | Que la suma de los pagos sea igual al bote, al centavo |

Las rutas de las tres zonas están en `.github/CODEOWNERS`. Hoy son `src/domain/access/`,
`src/domain/consumption/`, `src/domain/payout/`, `src/adapters/supabase/` y
`supabase/migrations/`, más las pruebas y los guiones que las hacen cumplir; los servicios
y adaptadores de cada zona se agregan ahí cuando su tarea los crea.

Los cuatro ejemplos de `../planeacion/01-prd.md` §6.3 son pruebas automáticas. Si fallan,
el cambio está mal aunque todo lo demás pase.

## Lo que nunca se hace

- Escribir una cifra de negocio en el código. Precio, IVA, porcentaje del bote, umbrales y
  plazos salen de la tabla de parámetros.
- Actualizar o borrar una fila de un libro (latidos, cobros, repartos, ajustes,
  auditoría). Un error se corrige con una fila nueva.
- Recalcular o modificar un periodo cerrado.
- Firmar una dirección de video o de archivo fuera de la función única de medios.
- Consultar la tabla de suscripciones desde una página para decidir qué mostrar. Se le
  pregunta al servicio de acceso.
- Dar por cierto lo que manda el navegador: un latido, el regreso de pagar, un rol.
- Poner un secreto en el código, en el navegador o en un registro.
- Escribir en registros, en correos o en analítica el historial de cursos de un alumno,
  datos fiscales o bancarios, o el texto de un caso de moderación.
- Escribir un texto visible fuera del archivo de mensajes.
- Crear una tabla expuesta sin su política por fila en la misma migración.
- Escribir una migración destructiva, o una migración de Payload que toque el esquema
  propio, o al revés.
- Usar datos reales fuera de producción.
- Agregar una dependencia sin decir para qué y sin revisar quién la mantiene.
- Construir algo de la lista «No entra en el MVP» del PRD, aunque parezca fácil.
- Saltarse una verificación para que algo pase.
- Copiar a este repositorio sueldos, porcentajes de sociedad o cualquier cosa de
  `../negociacion/`.

## Convenciones

- **Idioma.** Identificadores en inglés. Comentarios, mensajes de commit y documentación en
  español. Sin raya (el guion largo) en la redacción.
- **Nombres.** Los del glosario de `../planeacion/00-fundamentos.md` §3: `teacher`,
  `student`, `pool`, `watch_event`, `period`, `payout`.
- **Dinero.** Centavos enteros, con su moneda. Nunca números con decimales.
- **Tiempo.** Se guarda en UTC. El periodo se corta en `ZONA_HORARIA_PERIODO`. El reloj
  entra al dominio como argumento.
- **Entradas.** Toda entrada se valida en el borde del servidor, con un esquema por ruta.
- **Commits.** En español, con la tarea y el requisito: «T-205 Latidos con validación
  acumulada (RF-402)».

## Definición de terminado

1. Cumple los criterios de aceptación de sus requisitos, y hay una prueba que lo demuestra.
2. Pasan tipos, lint y las pruebas de las capas tocadas.
3. Si toca una pantalla, respeta su ficha del diseño y funciona con teclado y en teléfono.
4. Si toca la base, la migración corre desde cero y trae su política y su prueba.
5. Si toca una zona delicada, una persona la revisó y lo dijo por escrito.
6. Si el código obligó a cambiar una decisión, el documento de planeación y `../INDICE.md`
   quedaron al día en el mismo trabajo.

## Cuándo detenerse y preguntar

- La tarea pide algo que un documento prohíbe, o dos documentos se contradicen.
- Hace falta una decisión marcada como abierta (`PQ` o `ADR` sin cerrar).
- El cambio toca una zona delicada, un libro o un periodo cerrado.
- Hay que crear, borrar o reconfigurar algo en un proveedor (cobro, video, correo, base de
  producción).
- Una prueba de las tres zonas falla y la salida fácil es cambiar la prueba.
