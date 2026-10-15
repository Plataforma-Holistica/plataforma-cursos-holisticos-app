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

El gestor de paquetes es pnpm. Solo están aquí los comandos que ya existen; los de los
trabajos llegan con la tarea que los crea, y se escriben aquí ese mismo día.

```bash
pnpm install     # instala y activa el gancho de commit (.githooks/)
pnpm dev         # aplicación en local, en http://localhost:3000. La muestra de componentes: /muestra
pnpm typecheck   # tipos
pnpm lint        # lint, incluida la regla de capas
pnpm test        # dominio, textos, capas y contraste, y los componentes en un DOM simulado. Sin red ni base
pnpm test:coverage   # las pruebas de `unit` con cobertura: src/domain/access/ debe dar 100 %, archivo por archivo
pnpm secrets     # escaneo de secretos en todo el repositorio
pnpm build       # compilación de producción
pnpm db:start    # levanta Supabase en local (necesita Docker Desktop abierto)
pnpm db:status   # direcciones y llaves locales, las que pide .env.example
pnpm db:stop     # lo apaga; los datos se conservan
pnpm db:reset    # borra la base local y la rehace: migraciones, semilla, db:login y db:drafts
pnpm db:login    # le da a app_service entrada a la base local (ver .env.example)
pnpm db:drafts   # carga en la base local los textos legales de borrador (versión 0)
pnpm db:admins <correo> [<correo> ...]   # el arranque en local: invita a las primeras personas del equipo, con todas las capacidades
pnpm db:courses  # carga en la base local los cursos de prueba (T-107): sus prácticas y niveles, dos maestros ficticios y dos cursos por aprobar
pnpm media:upload-test [<archivo> ...]   # sube a Mux videos de ../Videos-Test/ (por omisión, uno) y deja sus identificadores para db:courses
pnpm media:check  # contra Mux: con una dirección firmada vigente sirve el video; caducada o sin firma, no
pnpm team:handoff   # imprime un código para dictar y su huella, para la emergencia. No toca ninguna base
pnpm db:migration <nombre>   # crea una migración vacía en supabase/migrations/
pnpm test:db     # pruebas de base (pgTAP) de supabase/tests/, contra la base local
pnpm test:int    # pruebas de integración de tests/integration/, contra la base, el Auth y el buzón locales
pnpm test:e2e    # extremo a extremo de tests/e2e/ (Playwright): un navegador contra la aplicación compilada y la pila local
pnpm test:e2e:equipo   # el camino del equipo, de extremo a extremo: deja residuo, y rehace la base local al terminar
```

Antes de dar una tarea por terminada corren, en este orden: `typecheck`, `lint`, `test` y
las pruebas de la capa que se tocó. Si se tocó la base: `db:reset` y `test:db`. Si se tocó
un adaptador o un servicio que llega a la base: `test:int`, y después `test:db` otra vez,
para comprobar que no dejó residuo. Si se tocó una pantalla, una ruta, una acción de
servidor o el paso previo: `test:e2e`, y después `test:db` otra vez, por lo mismo. La
integración continua (`.github/workflows/ci.yml`) corre lo mismo más `secrets`, la
auditoría de dependencias y `build`; después de compilar instala Chromium, corre el
extremo a extremo (con el comando escrito en `ci.yml`, no con el guion de `package.json`)
y las pruebas de base una vez más.

`pnpm test:e2e` necesita tres cosas. La pila local arriba y lista (`db:start`, `db:login` y
`db:drafts`, o `db:reset`). El puerto 3000 libre: Playwright compila la aplicación él
mismo (`next build && next start`) y la sirve en `http://localhost:3000`, que es a donde
apuntan los enlaces de los correos del Auth local; si ahí ya hay algo (un `pnpm dev`),
falla y lo dice, porque probar contra lo que haya no prueba nada. Y Chromium instalado,
una vez por máquina: `pnpm exec playwright install chromium`. Antes de levantar nada
comprueba que todo lo que va a tocar es la pila local, y le apaga el registro de errores.
Corre con un solo trabajador y en dos proyectos: escritorio, y teléfono para los casos
marcados `@telefono`. Los archivos son `*.spec.ts`, para que Vitest no los tome por suyos.
Las reglas de accesibilidad corren con el `axe-core` que ya estaba, inyectado en la
página: en un caso sin JavaScript no hay con qué correrlas. No corre contra una vista
previa: ahí no hay buzón que leer.

`pnpm test:e2e:equipo` corre aparte el camino de quien es del equipo
(`tests/e2e/equipo/*.equipo.ts`): invitada, prueba su buzón, configura su segundo factor,
entra de nuevo, da su código y llega a administración, con JavaScript y sin él. No corre
con `pnpm test:e2e`, y es a propósito: invitar, atar un factor y dar capacidades escriben
en la auditoría, que no admite borrado, y las pruebas de base cuentan esos renglones. El
guion (`scripts/e2e-equipo.mjs`) rehace la base local al terminar, pasen o fallen; si se
corta a la mitad, `pnpm db:reset` antes de `pnpm test:db`. Qué corre lo decide
`playwright.config.ts` con la variable `E2E_EQUIPO`, y en la integración continua es el
último paso. Corre también si se tocó una pantalla del equipo, su guarda, `team.ts` o
`team-admin.ts`. Sus últimos casos (el equipo se administra a sí mismo, PA-86) comparten a
dos personas con configuración que nacen con `pnpm db:admins`, y van en serie: cada uno usa
lo que dejaron los anteriores, y el grupo empieza dejando al equipo en esas dos personas
(lo que dejan los casos de arriba no es suyo). El último llama a la base directo, con dos
conexiones del dueño que toman el rol del servidor: para eso concede `app_service` a
`postgres` y lo quita al terminar, otro residuo que la base rehecha se lleva. Tardan varios
minutos, porque un código del segundo factor no se da dos veces y entre uno y otro hay que
esperar al siguiente.

`pnpm db:admins <correo> [<correo> ...]` es el arranque en una base local: invita a esas
personas con todas las capacidades, como dueño de la base declarado sistema
(`private.system_invite_admin()`). Cada quien acepta como cualquier invitada. Solo corre
contra la base local, con las mismas comprobaciones que `db:login` y `db:drafts`. Deja
renglones en la auditoría: después, `pnpm db:reset` antes de `pnpm test:db`. En
producción no hay guion: el arranque y la emergencia los hace a mano quien opera la base,
con las sentencias del manual de operación (`../planeacion/08-manual-operacion.md`,
OP-15). Para la emergencia, `pnpm team:handoff` imprime un código para dictar y su
huella, sin tocar ninguna base: a la sentencia va la huella, nunca el código.

`pnpm db:courses` carga los cursos de prueba de `supabase/local/test-courses.json`
(decisión de Sergio del 2026-10-14: no hay pilotos todavía, y los pilotos reales esperan a
T-004 y al documento de PQ-25). Sus prácticas y niveles, dos maestros ficticios sin cuenta
y dos cursos de dos lecciones, con videos del proveedor de prueba (`test`) que apuntan a
los archivos de `../Videos-Test/` (fuera de git), salvo las que ya tienen su video en Mux
(abajo, `pnpm media:upload-test`). Los cursos
quedan por aprobar, sin listar: los aprueba alguien con Contenido. Escribe como dueño de la
base declarado sistema, con el ajuste `app.local_courses`, que la base exige para un video
de prueba. Solo contra la base local, con las mismas comprobaciones que `db:drafts`;
correrlo dos veces no duplica nada. `db:reset` no lo corre, y deja renglones en la
auditoría: después, `pnpm db:reset` antes de `pnpm test:db`.

`pnpm media:upload-test` sube a la cuenta de Mux de quien desarrolla los videos de
`../Videos-Test/` que se le pidan (por omisión, «Nature + Forest.mp4»: decisión de Sergio
del 2026-10-14, uno por ahora) y escribe sus identificadores y la duración que mide Mux en
`supabase/local/test-videos.json`, que git ignora. Usa `MUX_TOKEN_ID` y `MUX_TOKEN_SECRET`
de `.env.local`, que la aplicación no lee. Cada video viaja con su huella y se busca antes
de subir: no se sube dos veces (salvo si se corta entre la subida y la creación del video
en Mux, una ventana de segundos). Exige política firmada (si Mux le diera un playback id
público, falla), no corre con `CI` ni en Vercel, y no imprime respuestas de la API. Con ese
archivo, `pnpm db:courses` carga esas lecciones con video de Mux y las demás con el de
prueba; si la base ya tenía los cursos con otros videos (otro proveedor, u otro video de
Mux) se detiene: `pnpm db:reset` antes. `pnpm media:check` es el criterio de T-108 contra
Mux: con una dirección vigente el manifiesto contesta 200, y caducada o sin firma, 403.
Firma con la llave de `.env.local` fuera de la función única de medios, y por eso tampoco
corre con `CI` ni en Vercel. Los dos
guiones repiten lo que sabe el adaptador: uno de Node no importa TypeScript.

Si se tocó `src/domain/access/`: `test:coverage`. Ahí la cobertura es del 100 % en ramas,
líneas, funciones y sentencias, sin comentarios de exclusión (una prueba de
`tests/architecture/` los prohíbe): una rama que no se puede cubrir sobra, y se quita. El
porcentaje no ve lo que decide una expresión regular o una tabla, así que no basta: cada
regla lleva su tabla de casos y sus propiedades, y antes de proponer el cambio se rompe a
mano cada condición para ver que alguna prueba falla.

`pnpm db:login` hace falta una vez por base: la migración crea a `app_service` sin permiso
de entrada, y ese guion se lo da con la contraseña de `DATABASE_URL`. Solo corre contra la
base local. `db:reset` lo repite, porque rehacer la base borra los roles.

`pnpm db:drafts` carga los tres textos legales sin los que no se completa un registro, como
borradores de versión 0 marcados sin validez. Tampoco corre fuera de la base local. La
base, por su parte, solo acepta una versión 0 del dueño de la tabla, declarado como
sistema y con el ajuste que pone ese guion: el servidor no puede cargarla. Las pruebas de
base pasan con los borradores cargados y sin ellos: la integración continua las corre en
los dos estados.

El Auth local se configura en `supabase/config.toml`, y sus correos en
`supabase/templates/`. Una clave mal escrita ahí se ignora sin error y sale el valor o la
plantilla de fábrica: por eso `tests/integration/30-auth-config.test.ts` comprueba cada
valor por lo que Auth hace, y cada plantilla por el correo que llega al buzón local.
Después de tocar cualquiera de los dos: `pnpm db:stop` y `pnpm db:start`, para que Auth
lo tome. Nada de eso llega al proyecto remoto: subirlo (`supabase config push`) es
reconfigurar un proveedor, y se pregunta.

Desde T-105 el Auth local tiene prendido el segundo factor por aplicación de códigos
(TOTP) y un gancho, `[auth.hook.mfa_verification_attempt]`, que apunta a una función de
la base (`private.second_factor_attempt()`). Auth la llama en cada intento de verificar
un código, y si la función falta o lanza, rechaza toda verificación: una migración que la
renombre o le quite el permiso a `supabase_auth_admin` deja al equipo sin entrar. Tampoco
entra nadie si a la función le falta uno de sus cuatro parámetros, o no es un entero de 1
en adelante: rechaza todo en vez de quedarse sin freno, con un mensaje propio («not
available», no «too many attempts») y un aviso en el registro de la base. TOTP queda
prendido para toda cuenta, no solo para el equipo. En el proyecto alojado ese gancho pide
los planes Teams o Enterprise de Supabase: ver la lista de salida
(`../planeacion/06-plan-implementacion.md` §8).

Versiones que no se suben sin revisar:

- **Next.js 16.3**. Esta versión cambió respecto a las
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
| `src/proxy.ts` | El paso previo de Next: renueva la sesión antes de cada petición y, en una lectura, manda a entrar a quien pide una pantalla con sesión sin tener ninguna | Servicios y `next/server` | La base, la guarda de sesión, `next/headers`, decidir quién pasa |
| `src/app/` | Rutas, acciones de servidor, páginas | Servicios | Cliente de base, SDK de proveedores, dominio de reparto |
| `src/app/_lib/` | Lo que comparten todas las pantallas: `request-context.ts`, el único archivo que lee la petición; `guard.ts`, la guarda en las páginas; y `guard-steps.ts`, la tabla pura de qué hace cada tipo de pantalla con cada respuesta de la guarda | Servicios | Decidir quién pasa: eso lo contesta `checkSession` |
| `src/app/(cuenta)/` | Las pantallas de la cuenta, cada una en su carpeta: `page.tsx` (llama a la guarda), `screen.tsx` (el formulario, que corre en el navegador), `actions.ts` (la acción de servidor) y `outcomes.ts` (la tabla pura de la pantalla). Lo que comparten, en su `_lib/` | Servicios, componentes base y textos | Un armazón o una plantilla propios: pintarían antes que la guarda de su página |
| `src/app/admin/` | Administración. Solo dos páginas: el inicio y el comodín `[...resto]`, que corre `requireAdmin` y sirve las secciones de la tabla de `_lib/sections.tsx` o contesta que la ruta no existe. Cada sección, en su carpeta privada (`_equipo/`, `_practicas/`). Lo que comparten (sus estados, PA-88; «Tu código»; el foco al contestar), en `_lib/` | Servicios, componentes base y textos | Una página propia para una sección; una ruta (`route.ts`), una pantalla de carga, un límite de espera o `metadata`: contestarían, se asomarían o se distinguirían antes que la guarda |
| `src/jobs/` | Trabajos programados y por evento | Servicios | Lo mismo que `src/app/` |
| `src/payload/` | Nada: sin uso desde el 2026-10-13, cuando Sergio decidió hacer el contenido con pantallas propias, sin Payload (T-106). La capa sigue declarada en el lint, vacía; se quita aparte | | Cualquier archivo |
| `src/ui/` | Los componentes base del diseño, compartidos por las cuatro superficies, y la hoja de tokens (`theme.css`) | Los textos, por bloque (`@/messages/es/ui`) | Servicios, dominio, adaptadores, configuración, y el catálogo entero |
| `src/messages/` | Los textos visibles, en un solo lugar: un archivo por bloque en `es/`, el bloque de términos y `t()` | Nada | Todo lo demás |
| `src/config/` | Las variables de entorno, leídas y validadas en un solo lugar | Nada de la aplicación | Todo lo demás |
| `supabase/migrations/` | El esquema propio, en SQL | | Objetos del esquema `payload`, que quedó sin uso |
| `supabase/tests/` | Pruebas de base en pgTAP: qué lee, qué escribe y qué se le niega a cada rol | `_ayuda.psql`, con `\ir` | |
| `supabase/seeds/` | Valores de arranque de los parámetros, transcritos de `00-fundamentos.md` §4 | | Cifras que no estén en ese documento |
| `supabase/templates/` | Las plantillas de los correos que manda Supabase Auth, mientras no los manda el proveedor de correo propio | | La dirección o el código que arma Auth: los enlaces llevan la huella y abren una página propia |
| `supabase/local/` | Lo que solo existe en una base local: los textos legales de borrador, un archivo por tipo, que carga `pnpm db:drafts`, y los cursos de prueba (`test-courses.json`), que carga `pnpm db:courses` | | Ser una semilla: todo `.sql` de `supabase/seeds/` viaja también a una base remota |
| `tests/integration/` | Pruebas del código contra la base local real, con personas dadas de alta en el Auth local. Un segundo factor de verdad sale de `helpers/auth.ts` (`secondFactorFor`) y sus códigos de `helpers/totp.ts`, sin dependencia nueva | Adaptadores y servicios | Dejar residuo: lo que escribe en una tabla auditada se revierte |
| `tests/ui/` | Pruebas de los componentes base, en un DOM simulado: teclado, nombres accesibles, estados y reglas automáticas de accesibilidad | Componentes y textos | Dar por probado lo que un DOM simulado no ve |
| `tests/actions/` | Pruebas de las acciones de servidor con sus servicios simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada respuesta | Las acciones de `src/app/` | Dar por probado lo que hace el servicio: eso lo prueban `tests/integration/` y el extremo a extremo |
| `tests/e2e/` | Pruebas de extremo a extremo con Playwright (`*.spec.ts`): un navegador de verdad contra la aplicación compilada, la pila local y su buzón, con JavaScript y sin él. Las corre `pnpm test:e2e` | Los ayudantes de `tests/integration/helpers/` que no cargan código de la aplicación | Correr contra algo que no sea la pila local, y dejar residuo |
| `tests/e2e/equipo/` | El camino del equipo de extremo a extremo (`*.equipo.ts`). Lo corre `pnpm test:e2e:equipo`, nunca la corrida normal | Lo mismo que `tests/e2e/` | Correr sin rehacer la base después: deja renglones en la auditoría, que no admite borrado |
| `tests/design/` | Lo que promete la hoja de tokens: la tabla de contraste del diseño, recalculada | | |
| `scripts/` | Guiones de desarrollo y de la integración continua | | Correr contra una base que no sea la local |

Las reglas viven en `eslint.config.mjs` (con `eslint-plugin-boundaries`) y rompen el lint.
`tests/architecture/layers.test.ts` comprueba cada una: si se afloja una regla, esa prueba
falla. Dieciséis precisiones que la tabla no dice:

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
- **`next/headers` solo se importa en `src/app/_lib/request-context.ts`** (TRD §4.2). Las
  cookies y las cabeceras de la petición se leen ahí y en ningún otro lado: da
  `cookieReader()` a las páginas, `cookieJar()` a las acciones y a las rutas, y
  `requestOrigin()`, que entrega `x-real-ip` y `user-agent` tal como llegaron. Una ruta
  tampoco lee `request.headers` por su cuenta. El adaptador de Auth recibe un tarro
  (`CookieJar`) y no conoce a Next. El paso previo, `src/proxy.ts`, arma el suyo sobre la
  petición y la respuesta. Solo importa servicios (`session.ts` y `navigation.ts`, que es
  puro) y hace dos cosas: renovar la sesión y mandar a entrar a quien pide una pantalla
  con sesión sin tener ninguna. Esa redirección es optimista y corta: solo en lecturas
  (`GET` y `HEAD`; un 307 a un envío lo reenviaría a otra pantalla), solo en las rutas de
  `SESSION_ROUTES`, y solo cuando la renovación contestó que no hay sesión o que se
  perdió («no se supo» no redirige). Lleva lo que la renovación escribió y no se guarda en
  caché. No lee la base, no corre la guarda y no es el control: haber pasado por él no
  dice que alguien tenga sesión. Una prueba sigue sus importaciones y exige que no lleguen
  a `db.ts`.
- **Una pantalla se arma siempre igual** (TRD §4.2 y §9.3). Las reglas para quien escriba
  una:
  - Toda página llama a la guarda que le toca (`requireSession`,
    `requireIncompleteSession` o `visitorOnly`, de `src/app/_lib/guard.ts`) o entra a la
    lista de públicas de `tests/architecture/screens.test.ts`. Una pantalla con sesión se
    agrega además a `SESSION_ROUTES` (`src/services/account/navigation.ts`) y atiende sus
    dos estados: cuenta suspendida (PA-35) y «no se supo» (PA-18, con «Reintentar»).
  - La guarda en las páginas le pregunta a `checkSession` y obedece. Qué hace cada tipo de
    pantalla con cada respuesta es una tabla pura, `guard-steps.ts`. `unavailable` nunca
    se trata como «sin sesión».
  - Toda ruta y toda acción de servidor entra a su lista en esa misma prueba. Las acciones
    van una por una, con lo que el cuerpo de cada una tiene que llamar, y un archivo de
    acciones no exporta ninguna que no esté ahí. Eso atrapa el olvido; lo que cada acción
    hace con cada respuesta lo prueban `tests/actions/` y su tabla. Las rutas solo
    atienden lecturas. La marca `"use server"` va al inicio del archivo, nunca dentro de
    una función.
  - No hay armazones ni plantillas además del de la raíz: pintarían antes que la guarda de
    su página.
  - La decisión de cada pantalla vive en una tabla pura, `outcomes.ts`, junto a ella y con
    su prueba: traduce lo que contesta el servicio a un destino o a lo que se pinta. Un
    caso nuevo se agrega ahí, no en la acción ni en el componente.
  - Una acción no le cree nada al estado anterior ni al formulario. Del estado anterior
    solo lee el número de intento. Lo que llega lo arma quien pide, y puede no ser un
    formulario: lo que no sea un texto, falte o venga desmedido cuenta como vacío. El
    servicio vuelve a correr la guarda. Una contraseña nunca vuelve en la respuesta.
  - Los formularios funcionan sin JavaScript: acción de servidor más `useActionState`.
    Con JavaScript, después de una acción la página no se vuelve a pedir si la acción no
    lo pide: cuando hace falta, la acción llama a `refresh()`. Una acción que escribe una
    cookie ya lo pidió sin decirlo: Next marca la ruta como cambiada con cada cookie que se
    escribe y pinta la página en la misma respuesta (leído en el código de Next 16.3, en
    `request-cookies.js` y `action-handler.js`). No se cuenta con que no se pinte. La validación al salir del
    campo usa las mismas reglas del dominio, que reexporta
    `src/services/account/field-rules.ts`, y solo si el campo ya trae algo. Ahí está
    también la del código del segundo factor (`parseSecondFactorCode`: seis dígitos, sin
    contar espacios): un código sin forma no llega a Auth, y por eso no cuenta en su
    freno. Su campo es `OTPField` (`src/ui/`), un solo campo sin tope de largo, para que
    pegar «123 456» no se corte.
  - Los textos van al catálogo (`src/messages/es/account.ts` para la cuenta). Un
    componente de cliente importa solo su bloque y nada del servidor: la prueba lo revisa.
  - A dónde se va lo decide `navigation.ts`: `resolveDestination` es el único lector de
    `volver`, contra una lista de destinos permitidos. Un aviso entre dos pantallas viaja
    en una cookie de 60 segundos con una clave de lista cerrada (`notice.ts`), nunca en la
    dirección.
  - Una página no puede borrar una cookie: para cerrar una sesión que la guarda rechazó
    manda a `/sesion/cerrar`, que vuelve a correr la guarda y solo cierra si ella lo dice.
    «Salir» es una acción de servidor, y además de cerrar la sesión se lleva el resguardo
    del buzón y el factor a medias de ese navegador (`forgetBrowserProofs`). Lo mismo
    cerrar la sesión propia desde la cuenta, que sale por `leaveFor` con `forgetProofs`.
    Una salida que cierra una sesión que la guarda rechazó no lo lleva.
  - El origen de una acción de servidor lo verifica Next. No se agrega una verificación
    propia, y «nulo» nunca entra a los orígenes permitidos. Por eso una página con
    formulario no lleva `Referrer-Policy: no-referrer`: rompe el envío sin JavaScript
    (TRD §9.2, fila «Cookies», y §9.8).
  - Un texto legal se lee con `currentLegalText` (`src/services/legal/`): solo los tipos
    públicos y solo el vigente. Su cuerpo se pinta como texto, nunca como HTML. El
    servicio recuerda lo leído treinta segundos, porque su página es pública y usa la
    reserva de conexiones con la que la gente entra. Por eso el enlace desde una casilla
    de consentimiento lleva la versión que la casilla anuncia (`?v=3`): si lo recordado
    es anterior, se vuelve a leer, y nadie lee una versión y acepta otra.
  - Una acción de la cuenta sale hacia otra pantalla por `leaveFor`
    (`src/app/(cuenta)/_lib/exit.ts`), con lo que dijo su tabla: cierra la sesión que ya
    no vale, deja el aviso y redirige, en ese orden.
  - Pedir un correo (registro, reenvío, recuperación) pasa por
    `src/app/_lib/mail-requests.ts`, que le da al servicio el `after()` de Next: la llamada
    a Auth corre detrás de la respuesta. Lo que la pantalla dice después (cuánto dura el
    enlace, cuánto se espera) se lee cuando el servicio ya contestó, nunca antes
    (`link-facts.ts`). Por eso una prueba de extremo a extremo que afirme «no llegó
    ningún correo» espera antes un correo de control, y todo caso espera sus correos
    antes de terminar: la limpieza no debe ganarle a un alta que viene en camino. Ese
    archivo es el único de `src/app/` que arma servicios de cuenta, y una prueba lo
    exige: armados sin `defer` correrían en línea. Si `after()` no puede encolar el
    trabajo, corre en el acto y se reporta (`mail_not_deferred`).
  - Lo que una página pública de la cuenta lee de la base pasa por `formFacts`
    (`link-facts.ts`), que lo recuerda cinco segundos, también cuando no se supo: esas
    páginas usan la misma reserva de conexiones con la que la gente entra. Una acción a la
    que el servicio le dice que un texto cambió llama a `forgetFormFacts` antes de volver
    a pintar.
  - Una espera que el navegador solo cuenta (el botón «Reenviar») le llega como tiempo que
    falta, no como hora (`useDelayIsOver`): su reloj no la acorta. Una hora que además se
    le dice a la persona (el freno de entrar) sí viaja como hora.
  - La página de un enlace del correo no llama a Auth ni gasta el enlace: pinta el
    formulario, y el servicio lo canjea al enviar, con todo ya revisado. Lo que no tiene
    forma de enlace (`isLinkToken`) no se le pregunta a nadie, ni en la página ni en la
    acción. Esas rutas llevan `Referrer-Policy: same-origin` desde `next.config.ts`.
  - El correo de un registro a medias viaja a «Revisa tu correo» en una cookie corta
    (`pending-registration.ts`), sin firma: nada se decide con ella, y lo que no sea
    exactamente lo que este código escribió cuenta como ausente.
  - Lo que se pinta al salir de un campo pasa por `useSeenOnBlur`
    (`src/app/(cuenta)/_lib/hooks.ts`). Se pinta cuando termina el clic o la tecla que
    sacó el foco (`afterInteraction`): un mensaje que aparece al bajar el botón del ratón
    recorre lo de abajo y el clic se pierde. Y vale hasta la siguiente revisión del
    formulario: manda lo último que pasó. Los campos que se repiten (el nombre, el correo
    al que se manda un enlace y la contraseña nueva) viven en `_lib/fields.tsx`; un campo
    nuevo con validación al salir se hace igual, no con su propio estado. Una pantalla que
    revisa antes de enviar lleva sus revisiones con `useLocalChecks`, y sigue la misma
    regla que cada campo: una revisión del navegador más nueva que la última respuesta del
    servidor tapa lo que esa respuesta dijo, aunque la siguiente todavía no llegue. Su
    cuenta de revisiones no retrocede, también cuentan las que salen bien: contra ella se
    mide qué manda en un campo, y con ella el resumen de errores sabe que hay algo nuevo
    que anunciar.
  - Dos hermanos nunca comparten `key`, tampoco un aviso y los campos que se rearman con
    cada intento: con la misma, React confunde uno con otro y el aviso de un intento se
    queda en pantalla con el siguiente. La preparación de las pruebas de componente
    (`tests/setup/dom.ts`) hace fallar toda prueba en la que React avise de eso.
  - Una pantalla cuya respuesta se pinta en ella misma (la de la cuenta, PA-25) va por
    bloques: cada bloque es una sección con su propio formulario, su `useActionState` y su
    resumen de errores. Tres cosas que las pantallas que navegan al terminar no necesitan:
    - El tercer argumento de `useActionState` es la dirección de la pantalla con el ancla
      del bloque (`"/cuenta#bloque-nombre"`). Sin JavaScript el navegador vuelve ahí, y no
      al principio de la página. El `id` del bloque no lo usa ninguna otra pantalla: si la
      acción redirige, el navegador se lleva el ancla al destino, y allá no debe apuntar a
      nada.
    - El foco vuelve a donde estaba al enviar (`useFocusKept`, en `_lib/hooks.ts`): con
      cada respuesta los campos se arman de nuevo y el foco caería al documento. Solo
      actúa si el foco quedó sin dueño; el resumen de errores sigue mandando.
    - El resultado se dice en el bloque, con un `InlineAlert` vivo, no con un aviso en
      cookie: ese es para ir de una pantalla a otra. Deja de decirse mientras hay otro
      envío en camino, con algo por corregir y en cuanto la persona vuelve a escribir:
      «Guardado» junto a un texto que no se ha guardado miente. En una prueba se busca por su texto y no por su
      papel, porque un botón con texto de carga siempre lleva su propia región viva.
    - Mientras el envío va en camino el campo queda de solo lectura: al llegar la
      respuesta se arma de nuevo, y lo tecleado entre tanto se perdería sin aviso.
    - Un bloque con varios botones (las sesiones abiertas) es un solo formulario, y cada
      botón dice lo suyo con su `name` y su `value`: así funciona sin JavaScript y el
      bloque lleva un solo estado. Lo que el formulario manda es qué botón se pulsó, y
      nada sobre de quién es la cuenta. Cuando el botón pulsado desaparece con la
      respuesta (su fila se fue), no hay a dónde devolver el foco: lo toma el aviso del
      resultado, que entonces no es además una región viva. A quien se fue a otra cosa
      mientras la respuesta venía en camino no se lo quita, y el resultado se le dice por
      una región viva aparte, que existe desde antes de cargar, igual que la que dice
      «Cerrando…»: sin eso no se enteraría. **Si se fue o no, no se deduce de dónde está
      el foco cuando llega la respuesta:** ese instante engaña, porque el botón pulsado
      queda inactivo o desaparece, y un campo de otro bloque puede estarse armando de
      nuevo, y en los dos casos el foco está en el documento. Se anota mientras se espera,
      con cada movimiento del foco: irse es ponerlo en algo que no contiene al bloque.
      Tres rondas de arreglos sobre esto, cada una rompiendo un caso vecino, se acabaron al
      escribir esa regla.
    - Los estados de todos los bloques viven en la pantalla, no en cada bloque: cualquiera
      puede contestar que la cuenta está suspendida, y eso sustituye a la pantalla entera.
    - Lo que un bloque pinta de la base llega ya en palabras desde la página (`rows.ts`):
      el navegador no necesita saber leer fechas, y se ve lo mismo con JavaScript y sin él.
    - En una cuenta con segundo factor, el bloque de la contraseña no pinta formulario:
      dice que se recupera desde el correo y enlaza ahí. Lo sabe la página al pintar; si la
      cuenta ganó su factor con la pantalla abierta, lo descubre el envío y el bloque cambia:
      el botón pulsado desaparece con el formulario, y la nota toma el foco si quedó sin
      dueño. A quien ya se fue a otro campo se le dice por una región viva que existe desde
      antes, en el mismo lugar en las dos formas del bloque.
    - Un bloque con contraseñas (el de la contraseña) no devuelve ninguna: después de
      cada respuesta sus campos se arman de nuevo, vacíos, y lo que el navegador detiene
      antes de enviar deja lo escrito como está. Su resultado va arriba de los campos, no
      junto al botón: sin JavaScript el navegador vuelve al principio del bloque, y más
      abajo quedaría fuera de una ventana baja. El freno de intentos lo dice con el mismo
      aviso que la pantalla de entrar (`_lib/throttled-alert.tsx`), porque es el mismo
      freno. Si el cambio dejó a la cuenta sin sesiones, la acción no cierra nada: el
      servicio ya lo hizo, y solo queda ir a entrar con el aviso que toca. El de «no se
      supo si cambió» no se pinta como algo que salió bien.

    Una prueba exige que el ancla de un bloque no se escriba en ningún otro archivo.
- **Las pantallas del equipo tienen su propia guarda** (T-105; flujo de la app §6.2 y
  §6.3). Quién es del equipo lo dice la base: la guarda de sesión a secas dejaría entrar a
  cualquier cuenta.
  - Son tres, en `src/app/_lib/guard.ts`. Le preguntan a `teamStanding` y obedecen cada
    una su tabla pura de `guard-steps.ts`: `requireAdmin(ruta, capacidad?)` para todo lo
    que cuelgue de `/admin`, `requireSecondFactor(volver)` para `/entrar/segundo-factor` y
    `requireFactorSetup()` para `/entrar/segundo-factor/configurar`. Una prueba de
    arquitectura exige que cada página del equipo use la suya y ninguna otra, y que las
    demás pantallas con sesión no usen ninguna de las tres: el segundo factor solo se pide
    en administración.
  - A quien no es del equipo ni tiene invitación le contestan `notFound()`: lo mismo que
    una ruta que no existe (PA-19). `unavailable` nunca se trata como «no es del equipo»:
    pinta PA-18, con «Reintentar».
  - Bajo `src/app/admin/` toda página llama a `requireAdmin`, y el comodín
    `[...resto]/page.tsx` corre esa guarda antes de decir que una ruta no existe. Sin él,
    una ruta de administración que existe y una que no existe se distinguirían con una
    cookie inventada, que provoca «no se supo» a voluntad.
  - **Una sección de administración no tiene página propia: la sirve el comodín.** Medido
    el 2026-10-13 con la primera (el equipo, PA-86): con su propia página, a quien no es
    del equipo el «no existe» le llegaba igual a la vista, pero el documento traía el árbol
    de rutas de Next y los fragmentos de esa página, y se distinguía del de una ruta que de
    verdad no existe; hasta el comodín nombraba a su ruta hermana. Servidas todas desde el
    mismo módulo, de una ruta a otra solo cambia la ruta pedida. Una sección nueva:
    - entra a la tabla de `src/app/admin/_lib/sections.tsx`, con la capacidad que pide (toda
      sección pide una);
    - vive en una carpeta privada, `src/app/admin/_nombre/`, sin `page.tsx`, y su entrada es
      un componente del servidor (`section.tsx`) que recibe las claims que la guarda dio.
      No corre la guarda por su cuenta: ya corrió;
    - y una prueba de arquitectura exige las dos cosas, y que bajo administración no haya
      más páginas que el inicio y el comodín. Una prueba de extremo a extremo
      (`tests/e2e/administracion.spec.ts`) compara, para una alumna, el documento entero de
      una sección contra el de una ruta que no existe, la petición por partes y un envío con
      el nombre de una acción inventada.
  - Ninguna página del equipo exporta `metadata`. Medido: cuando «no existe» lo contesta
    una página, el navegador se queda con el título por omisión del sitio, así que el de
    la página se asomaría justo ahí. Por eso la pestaña y el estado de una petición parcial
    no son los de una dirección cualquiera que no existe; entre rutas de administración,
    existan o no, sí son iguales, y eso es lo que se exige.
  - A dónde va quien acaba de quedar dentro lo decide `entryDestination(estado, volver)`
    (`navigation.ts`), con el estado que el servicio leyó al dejarla entrar
    (`standingAtEntry`, con las claims que Auth acaba de dar; no vuelve a leer la cookie,
    y del servicio solo sale el nombre del estado). Lo usan las tablas de entrar, de
    completar el registro y de completar la cuenta. Quien pidió una pantalla que no es de
    administración va a esa pantalla. Ese estado no autoriza nada: la pantalla a la que
    llegue vuelve a preguntar, y «no se supo» sigue como cualquier cuenta.
  - Configurar el segundo factor son dos formularios, cada uno con su `useActionState`, y
    no se juntan. La respuesta de «Empezar» trae la clave, y sin JavaScript React manda el
    estado de una acción dentro de todo formulario ligado a ella: mientras ese estado trae
    la clave no se pinta ningún formulario de «Empezar», y «Empezar de nuevo» es un enlace
    que vuelve a pedir la página. La clave no va en un campo oculto, no vuelve en otra
    respuesta, y deja de pintarse al enviar un código con forma y al salir de la página
    (un envío vacío o sin forma no es un intento, y no la esconde). El código QR se pinta
    con `<img>` y una dirección de datos, nunca como marcado, y la clave en texto va
    siempre junto a él.
  - Esos dos estados no saben uno del otro: la respuesta de confirmar se queda como está
    aunque después llegue una clave nueva. Por eso solo cuenta para la clave con la que se
    envió (`confirmedWith`): sin eso, quien recibía «esa clave ya no es la vigente» y
    empezaba de nuevo no veía la clave nueva. Lo encontró la revisión del diff.
  - La página de configurar no da de alta nada: una lectura no escribe cookies, y dar de
    alta borra los factores a medias, así que recargar rompería la otra pestaña. Por eso
    existe el paso «Empezar», que es una acción.
  - Todo estado de las dos pantallas del segundo factor lleva «Ir a mi inicio» y «Cerrar
    sesión» (`SecondFactorExits`): nadie se queda encerrado ahí.
  - PA-88 es `ForbiddenScreen` (`src/app/admin/_lib/states.tsx`). Se le pinta a quien es
    del equipo y no tiene la capacidad que la sección pide, nunca a quien no lo es. Hoy la
    piden el equipo (PA-86), configuración, y las prácticas y los niveles (PA-67), Contenido.
- **La pantalla del equipo (PA-86, `/admin/equipo`) va por bloques,** como la de la cuenta,
  y además cambia cosas que no se deshacen solas (RF-712). Vive en
  `src/app/admin/_equipo/`. Lo que no se ve leyendo un solo archivo:
  - **Los cambios se ofrecen solo si la página leyó que el código de quien mira es
    reciente** (`canChange`). Si no, arriba va el bloque «Tu código», y las listas se ven
    sin botones. Eso lo decide el dato de la página, nunca lo que contestó otro bloque: con
    JavaScript, la respuesta vieja de un bloque sobrevive a volver a pedir la página. Dado
    el código, la acción redirige en vez de pintar: recargar no reenvía un código.
  - **Cada bloque con varios botones es un formulario,** y todos sus botones se llaman
    `do`. Su valor dice el paso y a quién (`ask:revoke:<persona>:<capacidad>`,
    `confirm:…`, `cancel`): los arma `outcomes.ts`, que también los lee. Un envío sin `do`,
    o con más de uno, cuenta como vacío. A quién se le hace algo sale de ese valor, nunca
    del estado anterior.
  - **Quitar una capacidad, dar configuración, revocar y restablecer se confirman en dos
    pasos, dentro de la fila.** El primero (`ask`) no llama a ningún servicio: contesta
    «confirma», y la pantalla pinta qué va a pasar con lo que su página leyó (`rows.ts`).
    En el bloque de restablecer ese primer paso se llama `choose`, y tampoco llama a nadie.
    Lo que se confirmó que pasaría viaja en el botón de confirmar
    (`effectsKey(removalEffects(…))`), y el servicio relee: si ya no es eso, contesta
    `changed` y se pregunta otra vez con la lista de ahora. Una confirmación dice todo lo
    que la base hace, no solo lo que se pidió.
  - **A quien la guarda no dejó no se le dice «prohibido».** El servicio contesta
    `refused`, y la acción lo manda a `/admin/equipo`, donde decide la guarda: puede ser
    una alumna (PA-19), una invitada, o alguien a quien se le vencieron las doce horas con
    la pantalla abierta. Lo mismo cuando es la base la que contesta `forbidden`.
  - **Cada respuesta de la base tiene su caso en `outcomes.ts`,** y la prueba de la tabla
    recorre la lista cerrada de cada función: una respuesta nueva no compila sin su caso.
    «No se supo» nunca se pinta como hecho.
  - **Restablecer es un bloque aparte, con su acción y su estado.** Su respuesta trae el
    código que se dicta, y sin JavaScript React manda el estado de una acción dentro de
    todo formulario ligado a ella: mientras ese estado trae el código, el bloque pinta solo
    el código y un enlace de carga completa a la misma ruta, nunca un formulario. Como
    botón de cada fila del equipo, el código habría viajado en cada «Dar» y cada «Quitar».
    Con JavaScript deja además de pintarse al salir de la página y con el siguiente envío
    de cualquier bloque. Tres cosas más, de la revisión del diff:
    - Con el código en la mano la acción no llama a `refresh()`, y restablecer no escribe
      ninguna cookie: con JavaScript la página no se vuelve a pintar en esa respuesta, y si
      su lectura fallara, el código, que ya es el único que vale, se perdería. Dos límites
      conocidos: si el paso previo renovó la sesión en ese mismo envío (al token le
      quedaban menos de 90 segundos), esa cookie sí hace que Next la pinte (arriba, «una
      acción que escribe una cookie»); y sin JavaScript Next pinta la página siempre. Se
      sale restableciendo otra vez: la lista dice que esa persona quedó sin segundo factor.
      El costo: con JavaScript la lista queda sin actualizar hasta el enlace del bloque o el
      siguiente envío.
    - Un límite conocido, medido: en un envío sin JavaScript el documento de respuesta trae
      el estado de la acción una segunda vez, en los datos con que React se montaría. Es el
      mismo documento que ya pinta el código, no está en ningún campo y no viaja de vuelta;
      se va con la carga completa del enlace, y por eso el bloque no ofrece otra salida. La
      prueba de extremo a extremo cuenta dónde aparece el código en el documento entero.
    - Que el código deje de verse al navegar dentro de la aplicación depende de que la
      pantalla se desmonte. Con `cacheComponents` Next conservaría su estado y volver la
      repintaría con el código: una prueba de arquitectura exige que `next.config.ts` no lo
      prenda. Quien lo prenda esconde antes el código al desmontar.
  - Los textos van en su propio bloque del catálogo (`src/messages/es/admin.ts`), para que
    no viajen con la pantalla de entrar. Ningún plazo ni tope se escribe con su número.
  - A dónde va el foco cuando un bloque contesta es `useAnswerFocus` (`_lib/answer.tsx`,
    compartido con PA-67): la misma regla del bloque de sesiones de la cuenta, y por lo
    mismo.
  - **«Tu código» es el de `_lib/code-block.tsx`,** con su estado y su tabla
    (`_lib/fresh-code.ts`), compartidos con PA-67. Cada sección le da sus `id` y su página:
    dado el código, se vuelve a la propia página, nunca a la de otra sección. Y cada una
    tiene su servicio para darlo, porque cada una comprueba lo reciente con su propia
    lectura: el del equipo, con la lista del equipo, que es nula sin configuración.
- **La pantalla de las prácticas y los niveles (PA-67, `/admin/practicas`)** se arma como
  la del equipo (T-106; decisiones de Sergio del 2026-10-14: ordenar con «Subir» y «Bajar»,
  desactivar sin confirmar, y las desactivadas en su lugar). Vive en
  `src/app/admin/_practicas/`. Lo que no se ve leyendo un solo archivo:
  - Cada lista es un bloque con dos formularios ligados a la misma acción y al mismo
    estado: agregar y la lista. La acción es una por lista (`practicesAction`,
    `levelsAction`) y es la que dice de qué lista se trata; el formulario solo dice qué
    botón y qué fila.
  - **Mientras una fila está abierta para renombrar, el formulario de la lista no pinta
    ningún otro botón** que «Guardar» y «Cancelar» de esa fila. Con Enter en un campo, el
    navegador envía el formulario con su primer botón, con JavaScript y sin él: si fuera
    «Bajar» de otra fila, Enter movería esa fila y lo escrito se perdería. Lo encontró la
    revisión del plan; la prueba de extremo a extremo pulsa Enter.
  - **«Subir» y «Bajar» llevan la posición que se vio** (`up:<id>:<posición>`), y el
    servicio relee la lista antes de mover: si ya no es esa, contesta `changed` y no mueve.
    Así un formulario reenviado al recargar, o una pestaña vieja, no sube dos lugares. Es
    una relectura, no un candado: dos envíos casi a la vez (un doble clic sin JavaScript)
    pueden leer la misma posición. La base mueve dentro del candado de la lista, así que el
    orden nunca queda roto.
  - El nombre se revisa en la acción, antes de llamar al servicio, con la regla del
    dominio (`src/domain/catalog/name.ts`, que la pantalla toma de
    `src/services/catalog/field-rules.ts`): así un nombre sin forma se dice en su campo y
    no se pierde. La base revisa lo mismo y manda.
  - El foco tiene un dueño por respuesta: un error de un campo, el resumen de errores de
    su formulario; lo agregado, el campo de agregar, ya vacío, para seguir; lo movido, el
    mismo botón de la fila que se movió (o el del otro sentido), para seguir con el
    teclado; lo demás, `useAnswerFocus`. Lo agregado y lo movido se dicen además por una
    región viva propia del bloque.
  - Toda respuesta del servicio que no sale de la página la vuelve a pedir (`refresh()`),
    también «sin cambios» y «no se supo»: la lista pudo cambiar. Lo que no llama a nadie
    («Renombrar», «Cancelar», un nombre sin forma) no la pide.
  - El campo de agregar se arma de nuevo solo con una respuesta de agregar: el número de
    intento es del bloque entero, y como llave borraría lo que se estaba escribiendo cuando
    se pulsa otro botón del bloque.
  - Un «tu código ya no es reciente» que contestó un bloque deja de pintarse en cuanto la
    página lee un código reciente: después de darlo, ya no es cierto.
  - Los tonos de portada son clases (`bg-cover-1` a `bg-cover-8`, en `@theme` de
    `theme.css`), escritas enteras en un mapa: Tailwind no ve una clase armada con texto.
- **La sesión es una cookie que lleva el adaptador** (`src/adapters/supabase/auth*.ts`,
  TRD §8.10), sin `@supabase/ssr`. Lo que importa al usarlo:
  - `readSession` lee y verifica, y no puede renovar. `refreshSession` renueva: la llaman
    el paso previo y las acciones de servidor. Las dos solo miran la firma y la vigencia
    del token: una sesión cerrada en otro lado pasa hasta 15 minutos más. La guarda
    (`checkSession`) lo comprueba en la base, y lo que no pase por ella y no pueda esperar
    le pregunta a Auth con `confirmSession`.
  - Cada función contesta con una unión cerrada. `unknown` es «no se supo»: nunca se trata
    como éxito ni como «no hay sesión».
  - La cookie se borra solo con la lista cerrada de `auth-errors.ts`. Agregarle un código
    es decidir que con él se le cierra la sesión a alguien: un 429 o un corte de Auth no
    están ahí a propósito.
  - `signIn` distingue `banned` y `email_not_confirmed`. El servicio los aplana, porque
    delatan el estado de una cuenta.
  - El SDK de Auth se usa con un cliente de un solo uso (`oneShotClient`): uno compartido
    guardaría la sesión del último que entró. La API de administración solo se llama desde
    cuatro funciones de `auth.ts`: `requestSignUp`, que invita un correo, y tres que
    actúan sobre la cuenta de un enlace recién canjeado, `setFirstPassword`, `slimDown` y
    el segundo camino de `setRecoveredPassword`. Una prueba lo exige. `auth-client.ts` no
    se importa fuera del adaptador: lo rechaza el lint.
  - Cambiar la contraseña de una cuenta con sesión pide una prueba (`ProvenPassword`): la
    da `provePassword`, que entra con la contraseña actual y deja una sesión que no llega
    a ningún navegador. `changeProvenPassword` la gasta, y sirve para un solo intento;
    `discardProof` cierra esa sesión y `closeAllWithProof`, todas las de la cuenta. Un
    objeto con la forma de una prueba, armado en otro lado, no sirve: las de verdad viven
    en una tabla que solo el adaptador conoce. No hay camino por la API de administración.
  - Cuando Auth rechaza con un código que no está en la lista de la operación, la
    respuesta sigue siendo «no se supo» y el adaptador deja en el registro del servidor la
    operación, el estado y el código. Nunca el mensaje, que puede traer un correo.
  - Un token firmado con una clave que no se conoce no es, sin más, un token inventado:
    puede ser de una clave recién rotada. Mientras no se haya vuelto a preguntar por las
    claves, la respuesta es «no se supo» y la cookie no se borra.
  - El segundo factor son tres funciones, todas a nombre de la sesión de la cookie y
    ninguna por la API de administración. `enrollFactor` da de alta un factor de
    aplicación de códigos: antes quita los que la cuenta dejó a medias, y pide un reto en
    el acto, porque Auth borra los factores sin verificar de más de cinco minutos que
    nunca tuvieron uno. `verifyFactor` no abre otra sesión: sube de nivel la misma y
    escribe la cookie con los tokens que Auth entrega, después de comprobar que son de la
    misma cuenta y de la misma sesión. Distingue `wrong_code`, `throttled` (el gancho
    rechazó: Auth ya cerró todas las sesiones de la cuenta, y la cookie se borra; es el
    único código de esa lista con el que se le cierra la sesión a alguien), `factor_gone`
    (ya no existe: toca empezar de nuevo, no reintentar) y `no_session` (la sesión se
    cerró en otro lado; la cookie no se borra ahí: la guarda la rechaza en la siguiente
    petición). `removeFactor` quita uno, y uno que ya no está cuenta como quitado.
    `enrollFactor` entrega además el código QR que Auth ya manda hecho (un SVG de unos
    360 KB, con la clave dentro), solo si está hecho de lo esperado (`qr.ts`): una lista
    de permitidos, un `<svg>` con rectángulos y sus atributos de posición, tamaño y
    relleno. Cualquier otra cosa da nulo, y el alta vale igual con la clave en texto.
    Si una versión nueva de Auth dibuja distinto, el QR deja de salir y la prueba que lo
    mide falla: se amplía la lista a la vista. Tres
    cosas medidas contra el Auth local: el nivel es de la sesión y no del token (una copia
    de la cookie de antes de verificar renueva ya en segundo nivel, y con ella se puede
    dar de alta otro factor); al verificar un factor, Auth borra los demás que la cuenta
    tenía sin verificar; y con una sesión cerrada contesta `session_not_found`.
  - `createAuth({ fetch, now })` existe para las pruebas. El código de la aplicación usa
    las funciones ya armadas.
- **Los servicios de cuenta viven en `src/services/account/`** (TRD §9.2). `account.ts`
  llega a la base; `session.ts`, que es lo que importa el paso previo, no lo importa.
  Registrarse, recuperar la contraseña y completar una cuenta viven en `onboarding.ts`,
  con sus revisiones puras en `forms.ts` y lo que leen y escriben de la persona en
  `records.ts`; `account.ts` los arma. Administrar la cuenta (RF-109) vive en
  `management.ts`: lo que la pantalla de la cuenta pinta, el cambio de nombre, las sesiones
  abiertas y el cambio de contraseña. El cambio de correo espera a T-310.
  - `changePassword(jar, { current, next }, origin)` cambia la contraseña de la cuenta de
    la sesión que pide. **Una cuenta con segundo factor verificado no pasa de la guarda:**
    contesta `second_factor` antes de mirar lo escrito, sin contar un intento, y el bloque
    le dice que la recupere desde su correo. Auth exige una sesión de segundo nivel para
    cambiar la contraseña de esas cuentas, y la de la comprobación es de primer nivel
    (decisión del 2026-10-12). `accountSecondFactor(claims)` es lo que la página le
    pregunta antes de pintar el bloque; si no se supo, no se ofrece el formulario a
    ciegas. Para las demás, el orden es la regla, y no se cambia sin leer el TRD §9.2, fila
    «Cambio de contraseña desde la cuenta»:
    1. La guarda, y lo que se revisa sin preguntarle a nadie (`checkPasswordChange`, del
       dominio, la misma regla que usa el navegador). Lo que se detiene ahí no cuenta
       como un intento.
    2. El freno de intentos, con el par de la cuenta y la dirección: comprobar la
       contraseña actual es un intento de entrada, y se cuenta en el mismo freno que la
       pantalla de entrar. Sin eso, esta pantalla serviría para adivinarla con una sesión
       robada.
    3. La contraseña actual se comprueba entrando con ella (`provePassword`). Auth no la
       pide para fijar otra: con la sesión del navegador, a quien se llevara una cookie le
       bastaría eso. El correo con el que se entra sale de la sesión que pasó la guarda,
       y la entrada tiene que ser de esa misma cuenta.
    4. Esa entrada pasa por la guarda y se anota, como cualquier otra (`admit`): si empezó
       antes del último cambio de contraseña, o a la cuenta le falta algo, no sigue.
    5. Auth guarda la nueva con la sesión de esa entrada (`changeProvenPassword`): cierra
       las demás y manda el aviso CO-26. No hay segundo camino por la API de
       administración: si Auth la rechaza, no cambia nada.
    6. La base fecha el cambio y borra lo anotado (`private.note_password_change()`): una
       entrada en vuelo con la contraseña de antes ya no se anota.
    7. Se cierra la sesión de la comprobación y se entra con la contraseña nueva, que es
       la sesión que se queda en ese navegador. Su cookie se escribe en un tarro temporal
       y solo llega al navegador cuando la guarda la admitió.

    Hasta el paso 4, lo que falla deja todo como estaba y la sesión de la comprobación se
    cierra. Después del paso 5 ya no hay vuelta: si algo falla, la cuenta queda sin
    sesiones, la cookie se borra y la persona entra de nuevo (`signed_out`). Nunca queda
    una sesión abierta con la contraseña de antes. Si Auth no contestó al guardar, no se
    sabe cuál contraseña vale: el cambio se fecha de todos modos, se cierra todo y se
    reporta (`password_change_unconfirmed`). Si lo que falla es fechar, se reporta
    `password_change_incomplete`. Cuando la guarda niega la entrada de la comprobación
    (la cuenta se suspendió, cambió un texto), o Auth rechaza guardar, antes de darlo por
    caída se le vuelve a preguntar a la guarda, como al cambiar el nombre: la sesión de la
    comprobación pudo cerrarse desde otro lado, y entonces la del navegador tampoco vale.
    No así cuando esa entrada no se pudo anotar o la base no contestó: eso es «no se
    supo», con el reporte de la admisión, aunque la causa sea que las sesiones se cerraron
    en ese instante. Lo siguiente que la persona pida pasa otra vez por la guarda.
    Un límite de peticiones de Auth al guardar es un rechazo y no un «no se supo»
    (`provenPasswordFailure`): Auth lo contesta antes de tocar nada, y «no se supo»
    aquí cierra todas las sesiones de la cuenta. Deja su propio aviso en el registro del
    servidor: Auth lo cuenta por la dirección del servidor, así que es de todos a la vez.
  - `private.note_password_change()` no es `private.claim_account()`: fecha y borra lo
    anotado, pero nunca apaga la marca de contraseña ni le crea fecha a una cuenta que no
    la tiene. La marca dice que la contraseña la fijó quien controla el buzón, y quien la
    cambia desde la cuenta solo demostró que sabía la de antes. Toma el mismo candado de
    fila del perfil que anotar y cerrar sesiones, y se niega a correr fuera de read
    committed.
  - `accountSessions(claims)` da las sesiones abiertas de la cuenta, que son las anotadas y
    vivas, y dice cuál es la de quien pide: lo decide la base, que compara identificadores
    y no textos, igual que al cerrar. Si la de quien pide no viene (se cerró desde
    otro lado entre la guarda y la lectura) contesta «no se supo» sin reportar nada: no es
    una caída, y lo siguiente que la persona pida pasa otra vez por la guarda. «Última
    actividad» es la última vez que Auth renovó el token de esa sesión: no se mueve con
    cada uso. `closeSession` y `closeOtherSessions` vuelven a correr la guarda. De una
    sesión que se quiere cerrar llega su identificador, y lo que no tiene forma de serlo
    no llega a la base; la sesión propia no se cierra por ahí (su cookie quedaría
    apuntando a nada): la base contesta `current`, se escriba como se escriba, y la
    pantalla la saca por el camino de «Salir». Cuál se queda al cerrar las demás no llega
    de fuera: es la de la sesión que pasó la guarda. Aquí no se vuelve a evaluar la cuenta
    dentro de la transacción, como al cambiar el nombre: cerrar solo quita acceso. Lo que
    la base sí vuelve a mirar es que la sesión con la que se pide siga reconocida; si se
    niega, antes de darlo por caída se le vuelve a preguntar a la guarda, como al cambiar
    el nombre.
  - De qué navegador y sistema dice ser una sesión lo saca una regla pura del dominio
    (`user-agent.ts`), sin paquetes. Lo que no reconoce queda en nulo y la pantalla dice
    «desconocido».
  - En `management.ts` cada escritura vuelve a correr la guarda y escribe sobre la cuenta
    de esa sesión: nada de lo que llega dice de quién es. `accountProfile(claims)` lee como
    la persona (`asUser`), con las claims que la guarda le dio a la página. `changeName`
    exige una sesión que pase: a una cuenta a la que le falta algo se lo pide primero su
    pantalla. La guarda de sesión corre en su propia transacción, así que la de la
    escritura vuelve a evaluar la cuenta (`evaluateGate`), ya con el dato puesto, y lanza
    si dejó de pasar: una cuenta que se suspendió entre una y otra no cambia. El orden
    importa y una prueba lo fija: se guarda primero, que es lo que toma la fila, y se
    evalúa después. Si guardar falla, antes de darlo por caída se le vuelve a preguntar a
    la guarda de sesión: una cuenta que cambió a media operación no es una falla, y se
    contesta lo que la guarda dice ahora. Si insiste en que pasa, o tampoco supo, es «no
    se supo» y se reporta ahí mismo, sin contar con que la guarda reporte lo suyo. Una
    escritura que no tocó una fila tampoco es «guardado». Una prueba
    exige que la lectura vaya por `asUser` y la escritura por `asServer`.
  - El correo que la pantalla de la cuenta muestra es el de `sessionEmail`. No se le
    pregunta a Auth porque hoy ningún camino cambia un correo; cuando exista el cambio de
    correo (T-310), esa pantalla lo lee de Auth.
  - `checkSession(reader)` es la guarda de sesión: toda página y toda acción con sesión la
    llama, y obedece lo que contesta. Además de lo que decide el dominio, comprueba en la
    base que la sesión sea de las que abrió la aplicación y que siga viva en Auth. Una
    sesión abierta directo en Auth no pasa aunque su token verifique. No renueva: quien
    puede escribir cookies llama antes a `refreshSession`.
  - Una sesión solo se anota con `private.note_session()`, y solo la llaman `signIn` y la
    entrada con la que termina `completeRegistration`. Exige
    que el intento haya empezado después del último cambio de contraseña: Auth abre la
    sesión sin volver a mirar la cuenta, y una entrada en vuelo sobrevive al cambio. Ya
    anotada, queda etiquetada con el navegador desde el que se abrió
    (`private.tag_session()`, una vez): la cabecera `User-Agent`, limpia y recortada. Es
    para que su dueña la reconozca en su lista; no decide nada, y por eso va en su propia
    transacción y nunca impide entrar: si falla, la sesión se lista como de un navegador
    desconocido y se reporta (`session_not_tagged`). Las columnas `user_agent` e `ip` de
    `auth.sessions` no sirven para eso: Auth las reescribe en cada renovación con los
    datos del servidor.
  - Una sesión se cierra desde la cuenta con `private.close_session()` y
    `private.close_other_sessions()`, que borran en `auth.sessions` y en lo anotado en una
    transacción. Son la única manera en que el servidor borra una sesión de Auth: no tiene
    permisos sobre esa tabla. Ninguna recibe de quién es la cuenta. Las dos reciben la
    sesión con la que se pide, que tiene que ser de quien actúa, estar anotada y seguir
    viva, y que no se cierra por ahí. Toman un candado de fila del perfil, que choca con
    el de `note_session` y el de `claim_account` y entre sí, y se niegan a correr fuera de
    read committed: sin el candado, dos «cerrar las demás» a la vez desde dos sesiones de
    la misma cuenta se borraban una a la otra y la cuenta quedaba sin ninguna. Con él van
    una tras otra, y la segunda no cierra nada. Es `for no key update`, el que no estorba
    a quien inserta en una tabla que apunta al perfil; `note_session` todavía usa
    `for update` (`claim_account` ya no, desde T-105), y conviene pasarla a este cuando
    una tabla de mucha escritura apunte a `profiles`. «Las demás» se borran por cuenta y no por lo anotado: así se
    van también las abiertas directo en Auth. La guarda mira lo anotado en cada entrada,
    así que una sesión cerrada deja de pasar en el acto, sin esperar a que venza su token.
  - `signIn` cuenta el intento antes de preguntarle a Auth, como si fuera a fallar, y lo
    cierra después en otra transacción. La cookie se escribe en un tarro temporal: no
    llega al navegador hasta que la guarda dejó entrar y la sesión quedó anotada.
  - El freno y los topes se cuentan con candados consultivos (`lockAll`), siempre en el
    orden dirección, cuenta, buzón, antes de cualquier candado de fila y sin crear filas
    para decidir. Lo que se niega no deja nada.
  - Lo que traduce una decisión a un resultado, a cómo se cierra el intento y a si la
    sesión se queda es una tabla pura (`admission.ts`). Un caso nuevo se agrega ahí, con
    su prueba, no en el servicio.
  - `unavailable` es «no se supo»: nunca se trata como «sin sesión» ni como un «no».
  - Un fallo que nadie lanzó pero que alguien tiene que saber se reporta con
    `reportFailure(código)` (`src/services/error-reporting/server.ts`): lista cerrada,
    mensaje fijo, sin datos de nadie. Un código nuevo se agrega a la lista.
  - Las huellas del correo y de la dirección salen de `fingerprint.ts`, con
    `RATE_LIMIT_HMAC_SECRET`. Ni el correo ni la dirección se guardan en los contadores.
  - La dirección de quien pide solo se cree detrás de un despliegue de Vercel
    (`origin.ts`). Desconocida, va a un cubo compartido y nunca queda como par de
    confianza. `GET /api/origin-drill` sirve para medir esa cabecera en una vista previa:
    recibe una dirección de prueba y contesta cuatro banderas, nunca una dirección. En
    producción no existe.
  - `sessionEmail(reader)` da el correo del token ya verificado, solo para mostrarlo. No
    autoriza nada. `signOut` reporta `session_not_closed` si Auth no pudo cerrar, y
    `closeRejectedSession` es lo que hay detrás de `/sesion/cerrar`.
  - El registro es una invitación del servidor (`requestSignUp`, por la API de
    administración). Auth no acepta altas de fuera (`enable_signup = false` en `[auth]` de
    `supabase/config.toml`; no es el de `[auth.email]`), y la cuenta nace sin confirmar y
    sin contraseña. El enlace se canjea con el tipo `invite`. CO-01 sale por dos
    plantillas con el mismo texto, `invite` y `confirmation`, y una prueba compara que
    sean el mismo correo.
  - Pedir el registro y pedir la recuperación llevan cupos de correo separados: el del
    registro por buzón, el de la recuperación por correo exacto. Cada uno tiene además su
    tope por dirección, el único que se le dice a la persona. La espera entre dos correos
    se mide desde el último envío, no por ventana de reloj (TRD §9.9).
  - `requestRegistration` y `requestRecovery` contestan siempre lo mismo pasado el tope
    por dirección: exista o no la cuenta, se haya mandado algo o no. La llamada a Auth
    corre detrás de la respuesta, por la dependencia `defer`: sin nada que la mande
    detrás corre en línea, y las pantallas le pasan el `after()` de Next. Por eso estas
    dos no salen ya armadas de `account.ts`: quien tiene la petición arma las suyas con
    `createAccountServices`. Si Auth no manda el correo, también cuando lo rechaza por su
    propia espera, lo anotado se deshace y se reporta.
  - Canjear contesta `spent` cuando Auth gastó el enlace pero su sesión no se pudo usar.
    No es `unknown`: el enlace ya no sirve, y el servicio manda a recuperar o a pedir otro.
  - Canjear un enlace lo gasta. `completeRegistration` revisa antes todo lo que se puede
    revisar (datos y textos vigentes), y después del canje toda salida cierra la sesión
    del canje y dice qué hacer con un enlace que ya no sirve. Antes de fijar la contraseña
    deja una marca por cuenta: Auth deja pasar dos canjes simultáneos del mismo enlace, y
    solo el primero sigue. El orden está en el TRD §9.2, fila «Verificación de correo», y
    no se cambia sin leerlo.
  - `completeRecovery` cierra todas las sesiones siempre, falle lo que falle antes, y no
    abre sesión. `setRecoveredPassword` guarda con la sesión del canje y, si esa sesión ya
    no existe o la contraseña es la que ya tenía, por la API de administración: por ese
    camino el aviso CO-26 no sale, y se reporta. Hay un tercer caso que va por ahí y no es
    una falla: la cuenta tiene segundo factor, y Auth no deja cambiar la contraseña con la
    sesión de un enlace. Lleva su propio reporte (`recovery_with_second_factor`), para que
    una persona lo sepa. Con el buzón se recupera la
    contraseña, también la de esas cuentas; el segundo factor no se toca, y sin él no se
    entra a administración, no se cambia la contraseña otra vez ni se tocan los factores.
    Los demás pares de la cuenta pierden la confianza y conservan sus fallos.
  - El freno de los códigos del segundo factor no vive en la aplicación: vive en el gancho
    de Auth (`private.second_factor_attempt()`). Quien tiene la contraseña de una cuenta
    puede probar códigos llamando directo a Auth, y un código equivocado no gasta el reto:
    un freno en un servicio no lo vería. Usa la regla y los parámetros del freno de entrar,
    por factor. Mientras dura la espera no pasa ni el código correcto, y cuando el gancho
    rechaza, Auth además cierra todas las sesiones de esa cuenta, no solo la del intento
    (medido): a quien se equivocó de más hay que decirle que vuelva a entrar, o que
    recupere su contraseña desde su correo.
  - Los servicios del equipo viven en `team.ts` (T-105; TRD §9.2, fila «Invitaciones»).
    Quién es del equipo lo decide la base; aquí solo se decide a quién se le pregunta qué
    y en qué orden. Los cuatro corren primero la guarda de sesión, y lo que no sea «pasa»
    lo contestan tal cual:
    - `teamStanding(reader)` da el estado de quien trae esa sesión
      (`private.team_standing()`), con la huella del resguardo que traiga su navegador.
      Es lo que leen las guardas de las pantallas del equipo. Dice además qué factor dio de alta el
      servidor en ese navegador y en esa sesión (`inProgress`), para que la pantalla sepa
      que ya se empezó; no dice que ese factor siga existiendo. Si un estado tiene una
      capacidad lo contesta `holds(standing, capability)`: solo `member`, nunca lo que
      una invitación ofrece.
    - `startSecondFactor(jar)` da de alta el factor, solo a quien está `invited`, y anota
      cuál fue en una cookie del servidor (`enrolled-factor.ts`: `plataforma-factor`, con
      `__Host-` bajo https, quince minutos). El valor es `sesión.factor`, y con otra sesión
      no se lee. Devuelve la clave, su dirección `otpauth://` y el código QR: los tres
      se pintan una vez y no se guardan ni viajan en un campo oculto.
    - `confirmSecondFactor(jar, { code, handoff, painted })` verifica ese factor y, con la
      sesión ya en segundo nivel, acepta la invitación. **El factor que se le pasa a la
      base es el de esa cookie, nunca uno que llegue del formulario ni el que diga la
      sesión:** quien tuviera la sesión de la persona y verificara por fuera un factor suyo
      no logra que se ate. `painted` es el factor que la pantalla pintó, y solo se
      compara: si tiene forma de factor y no es el anotado (otra pestaña empezó de
      nuevo), se contesta `start_again` sin preguntarle a Auth, para que ese código no
      cuente en el freno, y sin borrar la anotación, que es de la otra pestaña. Una prueba
      de arquitectura exige que no se use para nada más. Y un segundo envío que encuentra
      a la persona ya atada justo al factor anotado en ese navegador se contesta
      `accepted`, con la misma limpieza; sin esa anotación, quien es del equipo recibe
      `not_invited` y conserva su sesión. Esa rama solo corre en una carrera: lo normal
      es que el segundo envío llegue con la sesión ya cerrada por la base, y la guarda
      conteste `must_sign_out`. La pantalla lo trata como caso normal. El código pasa
      por la regla del dominio aquí mismo (`parseSecondFactorCode`): sin forma se
      contesta `wrong_code` sin preguntarle a Auth. En un restablecimiento, sin un código dictado con forma no se verifica ni
      se le pregunta a la base: un nulo le cuenta como intento fallido
      (`handoffPrint`: sin espacios ni guiones, en mayúsculas, de 8 a 32 letras o dígitos).
      Aceptada, **la persona queda sin sesión**: la de equipo nace después de atar,
      entrando de nuevo y dando el código. Si no, la sesión que se vuelve de equipo existía
      antes de la atadura, y una copia de su cookie tendría un código reciente. La cierra
      la base, en la misma transacción que ata el factor; el servicio borra su cookie y le
      pide a Auth cerrarla de todos modos, y que ya no exista cuenta como cerrada (medido).
      Si Auth no contesta ahí, se reporta `session_not_closed`, que en ese camino ya no
      quiere decir «quedó abierta»: en la base está cerrada, y lo que no se supo es Auth. Con un
      no terminal de la base (`no_invitation`,
      `already_bound`, `inviter_lost_config`, `ineligible`, `needs_mailbox_proof`) el
      factor recién verificado se quita. **Pero nunca sin releer antes el estado.** Solo
      `accepted` y las dos que dicen que falta configuración (`needs_code`,
      `unavailable`) se toman tal cual; con cualquier otra respuesta, y también si aceptar
      no contestó (la transacción pudo confirmarse y perderse su respuesta), se vuelve a
      leer. Si la persona ya tiene su atadura (`member` o `needs_code`), se aceptó en otro
      envío o se perdió la respuesta: se contesta `accepted`, pase o no esa sesión la
      puerta, porque el factor de ese navegador puede ser justo el que quedó atado y
      quitarlo la dejaría sin con qué entrar (si la respuesta se perdió, queda dicho:
      `invitation_answer_lost`). Con `needs_handoff`, si la invitación ya no existe (el
      fallo que llega al límite la revoca, y la base contesta lo mismo), el factor se
      quita y se contesta `not_invited`; si sigue viva, se queda para el siguiente
      intento. Y si al volver a leer no se supo, nada se quita.
    - `giveSecondFactorCode(jar, code)` es dar el código al entrar, o darlo otra vez para
      un cambio al equipo que lo pide reciente. El factor es el que dice la base
      (`standing.factor`). Después de verificar vuelve a leer el estado: si no quedó
      `member`, es configuración (falta `VIGENCIA_SEGUNDO_FACTOR_HORAS`), y se reporta.

    A la base le preguntan por un almacén (`TeamStore`, y `TeamAdminStore` para lo de
    abajo), que arma `team-store.ts` sobre las consultas de `team-records.ts`. Aceptar
    confirma su transacción con cualquier respuesta, porque tres de sus rechazos escriben:
    por eso la respuesta se valida ya confirmada, fuera de la transacción. Un choque de
    candados (`isLockConflict`: 40P01 o 55P03) se intenta una vez más: al aceptar y en los
    cinco cambios al equipo, ninguno de los cuales escribe antes de rechazar. Leer el estado
    o la lista no se reintenta. «No se supo» nunca es un sí y nunca borra nada. Una prueba
    de arquitectura fija por dónde se le pregunta a la base y de dónde sale el factor.
  - Administrar al equipo vive en `team-admin.ts` (T-105, quinta solicitud; RF-712): la
    lista, invitar, invitar de nuevo, revocar una invitación, dar y quitar una capacidad,
    restablecer un segundo factor y dar el código otra vez. Quién puede lo decide la base,
    con su propia puerta (configuración y un código reciente); aquí se decide a quién se
    le pregunta qué, y en qué orden:
    - La guarda va primero (`admit`): `teamStanding`, y solo sigue quien es del equipo con
      configuración. Los demás reciben `refused`, sin distinguir por qué, y sin que se le
      pregunte nada más a la base. Si no se supo quién pide, `unavailable`: no se intentó
      nada. Una prueba de arquitectura exige que cada servicio empiece así.
    - Lo que llega se revisa antes de tocar la base: un identificador con forma (solo
      minúsculas, para que dos iguales se escriban igual), una capacidad de la lista, un
      correo que pase `parseEmail`. Lo que no tiene forma no llega (`malformed`).
    - Nada de lo que llega dice quién actúa: sale de la sesión que pasó la guarda.
    - Lo que la base contesta se entiende ya confirmada la transacción, contra la lista
      cerrada de su función (`INVITE_ANSWERS` y las demás). Una respuesta que no está en la
      lista, o una excepción, es `unknown`: se reporta (`team_change_unavailable`) y nunca
      se pinta como hecho. `forbidden` y `needs_fresh_code` salen tal cual.
    - `teamRoster(reader, claims)` lee la lista para la sección que ya pasó su guarda, con
      las claims que esa guarda dio. Una lectura nula, o sin la fila de quien pregunta, no
      vale: se le vuelve a preguntar a la guarda, y solo si insiste en que pasa se reporta
      (`team_roster_unavailable`). **Leer no pide el código reciente,** y es una decisión
      consciente: una sesión de equipo robada ve los correos del equipo, quién está sin
      factor y las invitaciones, pero no cambia nada.
    - `revokeCapability` y `resetSecondFactor` reciben lo que la persona confirmó que
      pasaría (`confirmed`) y releen la lista: si ya no es eso, contestan `changed` y no
      hacen nada. Quien se quita una capacidad a sí misma queda sin sesión (la base cierra
      todas las de la persona a quien se le quita): el servicio borra su cookie y contesta
      `revoked_self`.
    - `reinviteAdmin` no recibe a quién ni con qué: lo lee de la invitación caducada, por
      su identificador. Solo las que daban capacidades: una de restablecimiento caducada
      se arregla restableciendo otra vez.
    - **El código que se dicta al restablecer se genera aquí** (`dictatedCode`: dieciséis
      caracteres al azar, sin los que se confunden al dictar, en cuatro grupos). A la base
      va solo su huella, calculada con el mismo `handoffPrint` con que se comprobará al
      aceptar. El código sale en la respuesta una sola vez, y solo si la base contestó
      `reset`. No se guarda, no se reporta y no va en ninguna cookie.
    - **Restablecer lleva la versión de la persona** (decisión del 2026-10-13, que
      reemplazó un testigo en cookie). Restablecer no tiene tope de repetición en la base:
      un formulario reenviado (un doble clic sin JavaScript, o recargar) lo haría otra vez y
      mataría el código ya dictado. La versión (`private.reset_version()`, `n.a`: cuántas
      invitaciones tuvo esa cuenta en cualquier estado y cuántas aceptó) la trae la lista,
      la página la pone en el botón de confirmar, y `resetSecondFactor` la compara dos
      veces: primero con la lista (si ya no es esa, `already_sent` cuando lo pendiente es
      un restablecimiento de quien actúa, `changed` si no; así recargar después de
      restablecer dice «ya se envió» y no «la lista cambió»), y después la base, **dentro
      de su candado**: el segundo de dos envíos a la vez espera al primero, ve otra versión
      y no hace nada. La regla de «ya se envió» es la misma en los dos lados, y si la base
      contesta una de las dos, el servicio las traduce igual. La función de la base tiene
      que seguir siendo volátil: es lo que hace que la comparación, posterior al candado,
      vea lo que confirmó el envío que lo tenía (una prueba de base lo exige). Una
      confirmación ya no caduca: vale mientras la versión no cambie. Restablecer no escribe
      ninguna cookie. Nadie se restablece a sí misma: llega como `malformed`. Dos cosas que
      la versión no hace: con un doble clic sin JavaScript se restablece una sola vez, pero
      el navegador pinta la respuesta del segundo envío, así que no se ve ningún código y
      hay que restablecer otra vez (intercambio aceptado por Sergio); y lo confirmado
      (`alone`, `inviter`) se compara contra la lista fuera del candado, como antes: si en
      ese instante otra persona cambia el equipo, puede pasar sin su aviso. La ventana es de
      milisegundos; cerrarla pide recalcular esos avisos dentro de la base.
    - Al restablecer se avisa «quedarás como la única» (`alone`) solo si esa persona hoy
      puede cambiar el equipo: activa, con configuración y con su factor atado. A quien ya
      estaba restablecida no, porque hoy no cambia nada.
    - `giveFreshCode` da el código otra vez y después lee la lista: si sigue diciendo que
      el código no es reciente, pedirlo de nuevo no arregla nada (falta
      `VIGENCIA_CODIGO_RECIENTE_MINUTOS`), y contesta `not_available` y lo reporta. Que
      verificar otra vez mueva la hora que la base mira se midió el 2026-10-13 y lo fija
      `tests/integration/35-equipo-administrar.test.ts`.
    - No mandan ningún correo: la pantalla le dice a quien invita qué avisarle a la
      persona (decisión del 2026-10-13, hasta T-310). De Auth solo usan cerrar la sesión.
  - Cerrar la sesión de un navegador (`signOut`, `closeRejectedSession`) no se lleva el
    resguardo del buzón: completar la recuperación lo deja y, en la misma respuesta,
    cierra la sesión que ese navegador tuviera (`leaveFor`). Si cerrar se lo llevara,
    nadie con una sesión abierta podría probar su buzón. Que «Salir» sí se lo lleve es un
    paso propio de esa acción (`forgetBrowserProofs`, arriba), no del servicio.
  - `createAccountServices({ auth, proxyTrusted, isLocal, timing, report, defer, ticketLifetime, teamStore })` existe
    para las pruebas. En las de integración, lo que cambia el equipo corre con un almacén
    sobre una transacción del dueño que se revierte (`teamStoreOn`, en
    `tests/integration/helpers/team.ts`): la guarda y Auth corren de verdad, y la
    invitación y su aceptación no dejan nada en la auditoría. Cada caso de integración empieza con los contadores vacíos y su
    propia dirección (`tests/integration/helpers/account.ts`).
- **El cliente de base (`pg`) y el SDK de Supabase solo se importan en
  `src/adapters/supabase/`** (ADR-31, TRD §8.10). La aplicación entra a la base como
  `app_service`, que salta la seguridad por fila: por eso el resto llega con las tres
  funciones de `db.ts`, y siempre declara por quién actúa.
  - `asUser(claims, fn)`: lo que una persona lee o escribe por sí misma. La base filtra
    por ella. Solo acepta las claims que devolvió `verifyAccessToken`, y solo mientras su
    token no haya vencido.
  - `asServer({ claims, reason, requestId }, fn)`: una escritura que depende de una
    validación, a nombre de quien la pidió. Quién actúa y con qué sesión salen de esas
    mismas claims verificadas: no se declaran a mano, porque este camino salta la
    seguridad por fila. El nivel ya no viaja: para lo administrativo la base lo lee de
    esa sesión (abajo, «la puerta del equipo»).
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
- **Solo la función única de medios firma una dirección de video** (T-108; RF-305;
  TRD §5.5 y §9.4). Es `getMediaGrant` (`src/services/media/media.ts`): pregunta a la
  guarda del equipo, lee la lección como la persona (`asUser`: la política de Contenido es
  una segunda barrera), le pregunta a la regla del dominio
  (`src/domain/access/media-access.ts`) y firma con el adaptador (`src/adapters/mux/`).
  Lo que no se ve leyendo un solo archivo:
  - Hoy una sola regla: alguien del equipo con Contenido, para revisar (sin puntos). T-202
    suma las otras tres de RF-306. A quien no puede se le contesta `refused` antes de leer
    la lección; lo que no tiene video que firmar (no existe, retirada, de prueba, sin
    terminar, un id sin forma) contesta igual, `no_video`. El playback id sale de la base,
    nunca de quien pide.
  - Firma tres direcciones (video, miniatura y vista de avance) con un JWT RS256 hecho con
    `node:crypto`, sin dependencia. La vida es la de ADR-27: la lección entera a
    `VELOCIDAD_MIN` más diez minutos, con tope de 55 (`grantLifetimeSeconds`).
  - La llave de firma (`MUX_SIGNING_KEY_ID`, `MUX_SIGNING_PRIVATE_KEY`) es opcional y va en
    pareja: sin ella no hay video y lo demás funciona; falta o no sirve, se reporta
    (`media_grant_unavailable`). Fuera de local todavía no se carga (decisión del
    2026-10-14). No va a ningún registro ni error.
  - Una prueba de arquitectura (`tests/architecture/media.test.ts`) exige que el
    adaptador y las dos variables de la llave vivan solo ahí, que ningún otro archivo de
    `src/` firme (busca las maneras de Node y del navegador, y los paquetes de JWT), y que
    la lección se lea con `asUser`. La llave de firma es RSA de 2048 bits o más; una que se
    lee pero no firma contesta lo mismo que una que no sirve.
  - El adaptador va en `src/adapters/mux/`, no en `adapters/media/mux` como decía el TRD:
    aquí cada proveedor es su carpeta.
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

En la base, diez reglas que salen de `../planeacion/05-esquema-backend.md` §16.1:

- **Una tabla llega completa en su migración**: seguridad por fila, permisos, políticas,
  sus guardianes y su disparador de auditoría si es administrativa. Sin política, una
  tabla queda cerrada.
- **Ningún permiso por omisión.** `anon`, `authenticated` y `service_role` no reciben nada
  que la migración no conceda a mano. `private.schema_violations()` debe devolver cero
  filas, y `supabase/tests/01_estructura.test.sql` lo exige.
- **Una persona con sesión casi no escribe.** Lo que depende de una validación va por el
  servidor (`app_service`), que declara en la transacción por quién actúa y con qué
  sesión (`app.actor_id`, `app.actor_session`) o que es el sistema (`app.actor_kind`).
- **Ser del equipo lo dice la base, no el token** (T-105). `private.has_capability()` y
  `private.actor_has_capability()`, que usan todas las políticas y los disparadores
  administrativos, pasan por una sola puerta (`private.team_session()`), en cada consulta.
  Pide una capacidad activa, un factor atado a la persona (`private.admin_factors`) y una
  sesión que la aplicación abrió y que Supabase Auth tiene en segundo nivel con ese mismo
  factor, verificada hace menos de `VIGENCIA_SEGUNDO_FACTOR_HORAS`. Un token ya emitido
  sigue diciendo `aal2` hasta que vence, y con una sesión verificada cualquiera cambia su
  factor llamando directo a Auth: por eso no se le cree al token. Quien no tiene la
  capacidad no llega a leer nada de Auth, porque esas funciones viven en políticas de
  tablas que lee cualquier cuenta. Sin el parámetro, o con uno que no vale, no pasa nadie.
  El campo `aal` de las claims no sirve para decidir esto, tampoco en la guarda de una
  pantalla. Tres políticas restrictivas viejas (`*_require_aal2`) todavía lo leen con
  `private.is_aal2()`: no abren nada, porque van sumadas con «y» a una política que pasa
  por la puerta, pero en esas tablas un token de primer nivel no lee aunque su sesión ya
  esté verificada.
  En las pruebas de base, «segundo nivel» es una sesión de equipo de verdad: la deja
  `pruebas.equipar()`, que llaman `pruebas.como_usuario(…, 'aal2')` y, para quien tiene
  una capacidad, `pruebas.como_servicio()`.
- **Las prácticas y los niveles** (`public.practices` y `public.levels`, T-106; decisiones
  de Sergio del 2026-10-13) los cambia solo alguien del equipo con Contenido y un código
  reciente, y solo por las funciones `private.catalog_*` (agregar, renombrar, mover,
  desactivar y reactivar), con su puerta (`private.content_change_gate()`, la del equipo
  con Contenido en lugar de configuración) y el candado de cada lista. El servidor solo las
  lee, y el público lee las activas. Lo que no se ve leyendo una función:
  - Un guardián que **no** es `security definer` deja escribir solo al dueño de la tabla (es
    decir, a esas funciones) y a nombre de alguien que pasa la misma puerta, código reciente
    incluido, o del dueño declarado sistema (desde T-107: así crea el guion local las
    prácticas de los cursos de prueba, con `private.system_catalog_add()`; agregar se partió
    en la puerta y `private.catalog_place()`). Un ajuste de sesión no es una barrera: lo que
    cuenta es que escriba el dueño de la tabla, que el servidor no es. Nada cambia el
    id ni el slug, y nada se borra ni se vacía (el `truncate` no pasa por los disparadores
    de cada fila: el mismo guardián lo cierra aparte).
  - El nombre pasa a NFC antes de revisarse, en el servicio y en la base, y no admite
    caracteres de control ni de formato (el guion suave, los de ancho cero, los que
    invierten la dirección del texto): no se ven, y dos nombres iguales no lo parecerían.
    La tabla exige lo mismo.
    Su prueba concede dentro de la transacción el permiso que el servidor no tiene, porque
    sin eso la escritura moriría por permiso antes de llegar al guardián.
  - El slug se fija al crear y no cambia al renombrar: los filtros de explorar viven en
    direcciones guardadas. El nombre se compara normalizado (sin acentos ni mayúsculas, con
    `private.catalog_key()`), también contra las desactivadas. El tono de portada lo asigna
    la base al crear, por rotación de ocho en orden de creación.
  - Las posiciones son únicas con una restricción diferida: mover intercambia con la vecina
    activa en dos `update`, sin un valor intermedio.
  - La lista llega como el tipo enumerado `public.catalog_list`, y la tabla sale de él, nunca
    del texto que manda alguien.
  - El vigilante exige que ningún rol de la aplicación las escriba ni les ponga disparadores.
  - El servicio vive en `src/services/catalog/` y se arma como el del equipo: la guarda
    primero (`holds(…, "content")`), la forma antes de la base, las listas cerradas de
    respuestas, y «no se supo» se reporta (`catalog_change_unavailable`). Lo que las
    pantallas importan sale de `catalog.ts`. Una práctica o un nivel que usa un curso sin
    retirar no se desactiva: la base contesta `in_use` (T-107, `t107_en_uso`), y la lectura
    trae por fila cuántos la usan (`inUse`); PA-67 no ofrece desactivar y lo dice. Los
    borradores cuentan desde T-402. **Todo camino que liste un curso o le cambie la práctica
    o el nivel toma los candados de las dos listas y comprueba que estén activas**: si no,
    «en uso» tendría una carrera. `giveCatalogCode` da el código
    otra vez y comprueba lo reciente con las listas del catálogo; pasa dos veces por la
    guarda (antes, y después de verificar, porque verificar escribió la cookie), cada vez
    en su función, y una prueba de arquitectura lo exige.
- **Lo publicado** (T-107, migración `t107_lo_publicado`; ADR-21; decisiones de Sergio del
  2026-10-14): `teachers`, `published_teachers`, `course_registry`, `video_assets` y
  `published_courses`, `published_modules` y `published_lessons`. Lo que no se ve leyendo
  una función:
  - **Nadie de la aplicación las escribe.** El servidor solo las lee, y el público lee lo
    listado. Cargar un curso es `private.system_load_course()`, como el arranque del
    equipo: no es `security definer`, no tiene permisos para nadie y exige al dueño
    declarado sistema. Lo deja en revisión (`course_registry.state = 'in_review'`) y en lo
    publicado **sin listar**. Aprobar es `private.approve_course()`, del servidor, con la
    puerta de Contenido y un código reciente: lo lista y lo marca publicado. Un guardián en
    cada tabla deja escribir solo al dueño, declarado sistema o a nombre de quien pasa esa
    puerta, y nada se borra ni se vacía: lo publicado se oculta. El vigilante exige que
    nadie de la aplicación las escriba ni ejecute las funciones del sistema, y las pruebas
    de base, que cada tabla tenga su guardián.
  - La ficha de un maestro nace sin listar, y aprobar su primer curso la lista: su nombre
    no se ve antes. El orden de desempate no va ni a la auditoría.
  - **Un video de prueba** (proveedor `test`) solo lo acepta el guardián del dueño declarado
    sistema con el ajuste `app.local_courses`, que pone `pnpm db:courses`. No es un
    `check`: un `check` que lee un ajuste se vuelve a evaluar en cada cambio de la fila. Los
    de verdad son de Mux (T-108), y la función de medios rechazará cualquier otro.
  - Claves compuestas: una lección no queda en un módulo de otro curso, ni con un video de
    otro curso o de otro maestro. La duración de una lección es la de su video.
  - Cargar y aprobar toman los candados de las dos listas del catálogo (prácticas y después
    niveles) antes que el del curso (`private.course_lock()`), y se niegan fuera de read
    committed: desactivar una práctica y aprobar un curso que la usa van uno tras otro.
    Aprobar se niega si su práctica o su nivel ya no está activo: desde «en uso» eso solo
    pasa con una escritura por fuera de las funciones, y queda como defensa.
  - Sin Payload: el curso tiene su propio identificador y el video dice qué lección lo usa
    (`lesson_id`). `published_courses` nace sin `course_review_id`, que llega con las
    revisiones (T-405); cómo cumplen RN-16 los pilotos reales se decide con PQ-25.
  - El orden de desempate de un maestro (`tiebreak_rank`) no lo lee nadie de la aplicación:
    la lectura de `teachers` se concede columna por columna.
  - La pantalla para ver y aprobar un curso llega con T-108, cuando los videos se
    reproduzcan; hasta entonces los cursos de prueba se quedan por aprobar.
- **Una capacidad solo se recibe aceptando una invitación** (T-105), o de quien tiene
  configuración si ya se es del equipo. El servidor no escribe `admin_capabilities`: todo
  pasa por funciones de `private` que comprueban quién actúa, y el vigilante lo exige.
  Lo que hay que saber antes de tocarlas:
  - Cambiar el equipo (`invite_admin`, `revoke_admin_invitation`, `grant_capability`,
    `revoke_capability`, `reset_second_factor`) pide configuración y un código del factor
    atado de hace menos de `VIGENCIA_CODIGO_RECIENTE_MINUTOS`. Contestan `forbidden` a
    quien no tiene configuración y `needs_fresh_code` a quien la tiene y debe dar su
    código otra vez. Todas toman primero un candado fijo (`private.team_lock()`) y
    después, como mucho, el candado de fila de un perfil: van una tras otra. Cambiar un
    parámetro (`business_parameters`) pide ese mismo código reciente, por un disparador:
    los plazos son parámetros, y sin eso quien tiene la sesión de alguien con
    configuración se alargaría la ventana.
  - Aceptar (`accept_admin_invitation`) no mira la contraseña. Pide el resguardo del
    buzón (abajo), que la sesión esté verificada hace poco con el factor que el servidor
    dio de alta en ese navegador, y, si es un restablecimiento, el código que dicta quien
    restableció. Ata ese factor, da las capacidades de la invitación con quien invitó
    como autor, borra los demás factores de la cuenta y cierra todas sus sesiones,
    también aquella con la que se acepta (decisión del 2026-10-13): existía antes de la
    atadura, y si sobreviviera pasaría la puerta sin haber dado un código después de
    atar. Quien acepta entra de nuevo, y el estado que sigue a aceptar es `needs_code`.
    Tres de sus rechazos escriben antes de contestar (`needs_handoff` cuenta el fallo;
    `inviter_lost_config` y un `no_invitation` revocan la invitación): el servicio que la
    llame tiene que confirmar la transacción también en esos casos, o el límite de
    códigos dictados no contaría nada.
  - **El resguardo del buzón.** `private.claim_account(p_ticket)` guarda la huella
    (SHA-256 en hexadecimal) de un secreto que el servidor deja en el navegador que abrió
    el enlace del correo. Quien sabía la contraseña, quien la cambia por fuera o quien
    tiene una entrada en vuelo no lo tiene. Lo emiten `completeRegistration` y
    `completeRecovery` (`src/services/account/mailbox-ticket.ts`): 32 bytes al azar que
    genera el servidor, nunca algo que mande el navegador, en una cookie que la página no
    lee (`plataforma-resguardo`, con `__Host-` bajo https) y que dura
    `VIGENCIA_PRUEBA_BUZON_MINUTOS`, con un tope de un día. Cuánto dura se lee después de
    confirmado el reclamo, en su propia transacción. Se deja a toda cuenta que reclama, tenga o no una
    invitación, para no decir nada de nadie. `completeRecovery` lo deja solo si recibe el
    tarro del navegador; sin tarro reclama sin resguardo, y eso anula el que hubiera. Si
    falta el parámetro, no se pudo leer o la cookie no se puede escribir, el registro y la
    recuperación terminan igual, y queda dicho (`mailbox_proof_unavailable`,
    `mailbox_ticket_not_kept`). Una prueba de arquitectura exige que reclamar y emitir un resguardo
    solo ocurran en esos dos flujos. La cookie la leen los servicios del equipo
    (`team.ts`), y aceptar la borra. Las pantallas que los llaman son las dos
    del segundo factor (PA-12).
  - **En qué estado está alguien respecto al equipo** lo dice
    `private.team_standing(huella del resguardo)`, sobre quien actúa y sin escribir:
    `member`, `needs_code`, `invited`, `invited_unproven`, `unbound` o `none`. Lo lee
    `teamStanding` (`src/services/account/team.ts`), y es lo que leen las guardas de las
    pantallas del equipo, porque el servidor no puede leer las invitaciones ni las ataduras. Tiene que decir lo mismo que haría aceptar: una invitación que aceptar
    revocaría no cuenta. Si se cambia una condición de `accept_admin_invitation`, se
    cambia aquí también.
  - Hay dos tipos de invitación. `grant` da capacidades a quien no tiene ninguna.
    `rebind` no da nada: es para quien conserva capacidades y perdió su atadura
    (restablecimiento), y por eso aceptarla nunca devuelve una capacidad que se quitó
    entretanto. Invitar no le toca nada a una cuenta que ya existe; restablecer sí:
    quita la atadura, borra los factores, cierra las sesiones y prende la marca de
    contraseña.
  - Al reclamar, a una cuenta con invitación viva se le borran los factores que tuviera.
    A las demás no: recuperar la contraseña no quita un segundo factor, y a alguien del
    equipo no se le quita el atado.
  - **La lista del equipo** la da `private.team_roster()`, para la pantalla del equipo: en
    un solo valor, las personas con alguna capacidad, las invitaciones vivas y si quien
    mira dio su código hace poco. Es nulo para quien no pasa la puerta con configuración.
    Una sola función y no dos: con dos sentencias, «no pasas» y «no hay nadie» se verían
    igual. No pide el código reciente. Nunca devuelve la clave ni el identificador de un
    factor, la huella de un código dictado ni el resguardo de un buzón, y el servicio lee
    su respuesta con un esquema estricto: un campo que no conoce no pasa. Tiene que decir
    lo mismo que harían las funciones que cambian el equipo: `acceptable`, con las
    condiciones de `team_standing()`, y `config_removable`, con la cuenta de
    `revoke_capability()`. Si se cambia una, se cambia la otra. De cada persona da además
    su versión para restablecerla (`private.reset_version()`, interna), la misma que
    `reset_second_factor()` compara dentro de su candado.
  - El arranque y la emergencia (`system_invite_admin`, `system_reset_second_factor`)
    solo los ejecuta el dueño de la base, declarado sistema. No son `security definer` y
    no tienen permisos para nadie. La aplicación no las nombra, y una prueba de
    arquitectura lo exige: en local las llama `pnpm db:admins`.
  - Estas funciones borran y bajan sesiones y factores escribiendo en tablas de Supabase
    Auth (`auth.sessions`, `auth.mfa_factors`, `auth.mfa_amr_claims`). Un 40P01 o un
    55P03 de la base ahí es «no se supo, reintenta».
  - En las pruebas de integración, lo que cambia el equipo corre en una transacción del
    dueño que se revierte (`tests/integration/33-invitaciones.test.ts`): la auditoría no
    admite borrado. Por eso no hay una prueba de dos revocaciones que confirmen a la vez;
    se prueba lo que la impide, que cada función espera el candado de la anterior.
- **La prueba primero**, en `supabase/tests/`, y se la ve fallar antes de escribir la
  migración. Las migraciones se aplican solo en la base local.
- **En `profiles` el servidor escribe por columnas.** `app_service` no tiene `update` de la
  tabla entera: una columna nueva se le concede a mano en su migración, y si se olvida, el
  servidor recibe un error en vez de un acceso de más. La marca `password_reset_required`
  no se concede nunca: solo la apaga `private.claim_account()` y solo la prende
  restablecerle el segundo factor a alguien del equipo, y un guardián la cuida aunque
  alguien devuelva el permiso (TRD §9.2).
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
están ahí `src/services/account/`, `src/proxy.ts`, la configuración de Auth
(`supabase/config.toml`, `supabase/templates/`) y `supabase/local/`. Con las pantallas de
entrada se sumaron `src/app/_lib/`, `src/app/(cuenta)/`, `src/app/sesion/`,
`src/app/inicio/`, `src/app/api/origin-drill/`, `src/app/legal/`, `src/services/legal/`,
`src/messages/es/account.ts`, `next.config.ts`, `tests/proxy/`, `tests/e2e/` y
`playwright.config.ts`: una pantalla nueva con sesión se agrega ahí en el mismo cambio. Con
las de registro y recuperación se sumó `tests/actions/`. Con las prácticas y los niveles
(T-106), `src/services/catalog/`. Con las del equipo, `src/app/admin/`,
y con la pantalla del equipo, sus textos (`src/messages/es/admin.ts`): lo que una
confirmación dice que va a pasar.
Con el video (T-108), `src/services/media/` y `src/adapters/mux/`.
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
- Firmar una dirección de video o de archivo fuera de la función única de medios. La única
  excepción es `pnpm media:check`, un guion de una máquina que no corre en la integración
  continua ni en Vercel.
- Consultar la tabla de suscripciones desde una página para decidir qué mostrar. Se le
  pregunta al servicio de acceso.
- Dar por cierto lo que manda el navegador: un latido, el regreso de pagar, un rol, el
  estado anterior de un formulario.
- Servir una página sin su guarda y fuera de la lista de públicas, o una ruta o una acción
  de servidor fuera de su lista.
- Poner un secreto en el código, en el navegador o en un registro.
- Escribir en registros, en correos o en analítica el historial de cursos de un alumno,
  datos fiscales o bancarios, o el texto de un caso de moderación.
- Mandar al registro de errores el dato de una persona: ni en el mensaje de un error, ni
  como contexto, ni prendiendo una recolección que está apagada.
- Escribir un texto visible fuera del catálogo de `src/messages/`, o la palabra del rol
  fuera de su bloque de términos.
- Escribir un valor visual suelto o un estilo en línea, en vez de un token.
- Crear una tabla expuesta sin su política por fila en la misma migración.
- Escribir una migración destructiva (borrar el esquema `payload` o el rol `payload_app`,
  que quedaron sin uso, también lo es: se decide aparte).
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
3. Si toca una pantalla, respeta su ficha del diseño, funciona con teclado, en teléfono y
   sin JavaScript, y pasa su extremo a extremo.
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
