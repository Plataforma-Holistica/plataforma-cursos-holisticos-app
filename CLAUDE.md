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
pnpm dev         # aplicación en local, en http://localhost:3000. La muestra de componentes: /muestra
pnpm typecheck   # tipos
pnpm lint        # lint, incluida la regla de capas
pnpm test        # dominio, textos, capas y contraste, y los componentes en un DOM simulado. Sin red ni base
pnpm secrets     # escaneo de secretos en todo el repositorio
pnpm build       # compilación de producción
pnpm db:start    # levanta Supabase en local (necesita Docker Desktop abierto)
pnpm db:status   # direcciones y llaves locales, las que pide .env.example
pnpm db:stop     # lo apaga; los datos se conservan
pnpm db:reset    # borra la base local y la rehace: migraciones, semilla, db:login y db:drafts
pnpm db:login    # le da a app_service entrada a la base local (ver .env.example)
pnpm db:drafts   # carga en la base local los textos legales de borrador (versión 0)
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

`pnpm db:drafts` carga los tres textos legales sin los que no se completa un registro, como
borradores de versión 0 marcados sin validez. Tampoco corre fuera de la base local, y la
base rechaza una versión 0 que no venga de ese guion. Las pruebas de base pasan con los
borradores cargados y sin ellos: la integración continua las corre en los dos estados.

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
| `src/ui/` | Los componentes base del diseño, compartidos por las cuatro superficies, y la hoja de tokens (`theme.css`) | Los textos, por bloque (`@/messages/es/ui`) | Servicios, dominio, adaptadores, configuración, y el catálogo entero |
| `src/messages/` | Los textos visibles, en un solo lugar: un archivo por bloque en `es/`, el bloque de términos y `t()` | Nada | Todo lo demás |
| `src/config/` | Las variables de entorno, leídas y validadas en un solo lugar | Nada de la aplicación | Todo lo demás |
| `supabase/migrations/` | El esquema propio, en SQL | | Objetos del esquema de Payload |
| `supabase/tests/` | Pruebas de base en pgTAP: qué lee, qué escribe y qué se le niega a cada rol | `_ayuda.psql`, con `\ir` | |
| `supabase/seeds/` | Valores de arranque de los parámetros, transcritos de `00-fundamentos.md` §4 | | Cifras que no estén en ese documento |
| `supabase/local/` | Lo que solo existe en una base local: los textos legales de borrador, un archivo por tipo, que carga `pnpm db:drafts` | | Ser una semilla: todo `.sql` de `supabase/seeds/` viaja también a una base remota |
| `tests/integration/` | Pruebas del código contra la base local real, con personas dadas de alta en el Auth local | Adaptadores y servicios | Dejar residuo: lo que escribe en una tabla auditada se revierte |
| `tests/ui/` | Pruebas de los componentes base, en un DOM simulado: teclado, nombres accesibles, estados y reglas automáticas de accesibilidad | Componentes y textos | Dar por probado lo que un DOM simulado no ve |
| `tests/design/` | Lo que promete la hoja de tokens: la tabla de contraste del diseño, recalculada | | |
| `scripts/` | Guiones de desarrollo y de la integración continua | | Correr contra una base que no sea la local |

Las reglas viven en `eslint.config.mjs` (con `eslint-plugin-boundaries`) y rompen el lint.
`tests/architecture/layers.test.ts` comprueba cada una: si se afloja una regla, esa prueba
falla. Ocho precisiones que la tabla no dice:

- **`process.env` solo se lee en `src/config/`.** El resto llama a `getEnv()`. Adaptadores
  y servicios pueden importar la configuración; el dominio, `src/app/` y `src/jobs/`, no.
  `src/instrumentation.ts`, el arranque de Next, la valida antes de la primera petición y
  termina el proceso si falta una variable. Una variable nueva se agrega al esquema de
  `src/config/env.ts` y a `.env.example` en el mismo cambio. Lo poco que el navegador
  puede saber vive aparte, en `src/config/public-env.ts`: `next.config.ts` lo copia de
  las variables del servidor al compilar, para configurar cada valor una sola vez.
- **`src/app/` y `src/jobs/` importan solo servicios** (y `src/app/`, además, los textos
  y los componentes base).
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
- **Ningún texto visible se escribe en una pantalla ni en un componente** (RNF-15). El
  lint rechaza, dentro de `src/app/` y `src/ui/`, el texto entre etiquetas y todo texto
  escrito a mano en un atributo o en una prop, también elegido con una condición
  (`{ok ? "Listo" : "Falló"}`), y el título de una pantalla en `metadata`. La regla va al
  revés de lo intuitivo: solo se permite escribir a mano en los atributos que no son para
  la gente (`className`, `type`, `href`, `variant`…). Una prop nueva que no es texto se
  agrega a `NON_TEXT_ATTRIBUTES` en `eslint.config.mjs`. Lo que el lint no ve es un texto
  guardado en una constante o devuelto por una acción de servidor: eso lo cuida la
  revisión. Un texto nuevo se escribe en su bloque de `src/messages/es/` y se muestra así:
  - sin marcadores, tal cual: `{messages.states.home.status}`;
  - con marcadores, con `t()`: `t(text.reference, { code })`. Un marcador de término
    (`{el_maestro}`, `{Plataforma}`) lo pone `t()` sola; un dato (`{count}`) se le pasa, y
    si falta no compila. Un texto con marcadores no es un texto sino una plantilla: no
    compila ni se pinta sin pasar por `t()`, así que sus llaves no llegan a la vista de
    nadie por olvido;
  - la palabra del rol y el nombre de la Plataforma no se escriben nunca: se citan con su
    marcador. Viven en `es/terms.ts`, y una prueba recorre el catálogo para comprobarlo.

  Una pantalla del servidor importa `@/messages`. Un componente de `src/ui/` y todo
  archivo con `"use client"` importan solo su bloque (`@/messages/es/ui`,
  `@/messages/format`), para que el catálogo entero no viaje al navegador.
- **Todo valor visual es un token** de `src/ui/theme.css`. No hay estilos en línea (los
  rechaza el lint, y los rechazará la política de seguridad de contenido), ni valores
  sueltos entre corchetes (`bg-[#fff]`, `w-[317px]`: también los rechaza el lint), ni
  paleta de fábrica de Tailwind: `bg-red-500` no existe. Un solo tema, oscuro. Si falta un token,
  se agrega ahí y en el diseño (`../planeacion/03-diseno-ui-ux.md` §3), no se escribe el
  valor suelto. Si cambia un color, `tests/design/contrast.test.ts` dice qué pares revisar.
- **A Sentry solo salen errores, y sin datos personales** (RNF-16, TRD §10.5). El SDK
  (`@sentry/*`) solo se importa en `src/adapters/sentry/`. El arranque y las pantallas de
  error piden al servicio `src/services/error-reporting/`: `server.ts` para el servidor y
  `browser.ts` para el navegador, que no se mezclan porque el segundo viaja en la
  descarga.
  - Lo que el SDK recolecta por su cuenta (cabeceras, cookies, cuerpos, parámetros, datos
    de la persona) está apagado en `options.ts`, categoría por categoría. Si una versión
    nueva agrega una categoría, deja de compilar hasta que alguien la decida.
  - Todo error pasa además por `scrubEvent` (`scrub.ts`) antes de salir. El filtro no
    quita lo malo: arma un evento nuevo y copia solo lo que conoce, y cada valor solo si
    tiene su forma. De la persona, su identificador; de la petición, el método y la
    dirección sin parámetros; de la pila, dónde fue (archivo, función, línea), sin las
    líneas de código ni las variables; y el entorno que anota el propio SDK. Lo que no
    está en sus listas no sale: ni `extra`, ni una etiqueta o un contexto que alguien
    agregue, ni un campo que traiga una versión nueva del SDK. Una etiqueta nueva se
    agrega a `ALLOWED_TAGS`, a la vista de quien revisa.
  - Todo texto que sale pasa por reglas que buscan formas (un correo, un RFC, una llave,
    un teléfono): el mensaje del error, y lo que la pila hereda de él, porque el SDK arma
    la pila leyendo ese texto. Reconocen formas, no significados: un nombre propio pasa.
    Es una red, no un permiso: **el mensaje de un error no lleva el dato de una
    persona**, ni texto que venga de fuera sin revisar, y tampoco se lanza un objeto con
    datos como si fuera un error.
  - Solo errores, en el servidor y en el navegador: sin trazas, sin registros, sin
    métricas, sin grabación de sesiones, sin el aviso de cada visita o de cada petición,
    sin la consola ni los clics como contexto, y sin cabeceras de rastreo hacia terceros.
    La tasa de trazas no se define, ni en cero: para el SDK un cero ya es «trazas
    prendidas». Como sin definir el SDK leería `SENTRY_TRACES_SAMPLE_RATE`, la aplicación
    se niega a iniciar si esa variable existe. Prender cualquiera de esas cosas es una
    decisión aparte.
  - Las integraciones del SDK van por lista de permitidas, en `server.ts` y en
    `browser.ts`: una que no está en la lista no se instala, aunque el SDK la traiga de
    fábrica. Una nueva se agrega después de leer qué recolecta: `ContextLines` no está
    porque abría cualquier archivo que la pila nombrara y mandaba sus líneas. Una prueba
    enciende el SDK de verdad y revisa la lista exacta y lo que saldría
    (`real-sdk.test.ts`): es la que avisa cuando una versión nueva del SDK cambia algo.
  - Al salir hay una última puerta (`transport.ts`): lo que no es un error se descarta,
    lo haya pedido quien lo haya pedido. Un aviso de trabajo programado o un comentario
    de una persona no pasarían por el filtro; si algún día se quieren, esa puerta se abre
    a propósito y con su propio filtro.
  - `@sentry/*` no se importa en ningún otro lado de `src/`, tampoco con `import()` ni
    con `require`: `Sentry.setUser` o `Sentry.logger` desde un servicio se saltarían el
    filtro.
  - El arranque (`src/instrumentation.ts`) se compila también para Edge: lo que es solo
    de Node (`server.ts`) se carga dentro de su rama de Node, y lo que Next llama al
    fallar una petición vive en `request-error.ts`. Si el registro de errores no
    enciende, la aplicación atiende igual y lo dice en los registros del servidor: al
    revés que con las variables de entorno, sin las cuales no inicia.
  - En el navegador el SDK no viaja con la página, porque pesa y casi ninguna visita lo
    necesita: `browser.ts` lo pide aparte cuando el navegador queda libre, o en el momento
    de reportar, y guarda mientras tanto los errores que ocurran. Lo que se use del SDK
    se exporta en `browser-sdk.ts`: pedir el paquete entero descarga casi el triple.
  - Sin `SENTRY_DSN` no se manda nada: así se trabaja en local. Fuera de local es
    obligatoria, cifrada y con la forma que el SDK acepta (con otra, el SDK no falla: se
    queda callado). Los mapas de código solo se suben al compilar en Vercel, y de ellos
    saca Sentry el código que muestra junto a cada punto de la pila.
  - El simulacro: `GET /api/error-drill` falla a propósito (en producción responde 404),
    y `/muestra/error`, solo con `pnpm dev`, rompe la pantalla desde el navegador.

Un componente base nuevo entra primero al inventario del diseño (`03` §5) y se construye
sobre elementos nativos: la biblioteca de primitivas no está decidida (D-14). Su prueba va
en `tests/ui/`, con teclado simulado y `a11yViolations()` de `tests/setup/a11y.ts`. Lo que
un DOM simulado no ve (foco visible, tamaños táctiles, 320 px, movimiento reducido) se
revisa en `/muestra`, que solo existe con `pnpm dev`: se le agrega el componente.

En la base, seis reglas que salen de `../planeacion/05-esquema-backend.md` §16.1:

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
- **En `profiles` el servidor escribe por columnas.** `app_service` no tiene `update` de la
  tabla entera: una columna nueva se le concede a mano en su migración, y si se olvida, el
  servidor recibe un error en vez de un acceso de más. La marca `password_reset_required`
  no se concede nunca: solo la apaga `private.claim_account()`, y un guardián la cuida
  aunque alguien devuelva el permiso (TRD §9.2).
- **Un ajuste de sesión no es una barrera.** El servidor puede poner cualquier
  `set_config`, así que una regla que dependa solo de un ajuste se puede falsificar desde
  una consulta mal escrita. Las reglas duras miran además quién ejecuta (`current_user`
  contra el dueño de la tabla) o se apoyan en un permiso. Y el vigilante mira también los
  permisos por columna, que no salen en los permisos de tabla.

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
`supabase/migrations/`, más las pruebas y los guiones que las hacen cumplir. De la cuenta
ya están ahí, aunque todavía no existan, `src/services/account/`, `src/proxy.ts`, la
configuración de Auth (`supabase/config.toml`, `supabase/templates/`) y `supabase/local/`.
Los demás servicios y adaptadores de cada zona se agregan cuando su tarea los crea. También tiene dueño
`src/adapters/sentry/`: no es una de las tres zonas, pero decide qué sale hacia un
tercero.

**Cómo entra un cambio.** Toda solicitud la abre el agente, desde la terminal, y espera a
que la integración continua pase. Lo que sigue depende de lo que toca:

- **Toca una ruta con dueño** (las de `.github/CODEOWNERS`): GitHub no deja fusionarla sin
  la aprobación de un dueño. Quien abre una solicitud no puede aprobarla, así que la
  aprueba Sergio desde la otra de sus dos cuentas, las dos dueñas. El agente la propone y
  se detiene. Ya aprobada, la fusiona Sergio, o el agente si Sergio se lo pide.
- **No toca ninguna:** entra con la integración continua en verde. La fusiona el agente
  cuando el cambio lo pidió Sergio; si lo propuso el agente por su cuenta, la deja
  propuesta.

La protección de `main` no se cambia para dejar pasar una solicitud: eso es reconfigurar
un proveedor, y se pregunta. `main` no se despliega mientras producción no exista
(`vercel.json`), así que fusionar no publica nada.

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
- Mandar al registro de errores el dato de una persona: ni en el mensaje de un error, ni
  como contexto, ni prendiendo una recolección que está apagada.
- Escribir un texto visible fuera del catálogo de `src/messages/`, o la palabra del rol
  fuera de su bloque de términos.
- Escribir un valor visual suelto o un estilo en línea, en vez de un token.
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
