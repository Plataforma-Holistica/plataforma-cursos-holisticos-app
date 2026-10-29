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
pnpm test:coverage   # las pruebas de `unit` con cobertura: src/domain/access/, src/domain/consumption/ y src/domain/progress/ deben dar 100 %, archivo por archivo
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
pnpm media:captions-test [<archivo>]   # le agrega a un video de prueba de Mux la pista de subtítulos escrita a mano
pnpm db:student [<correo@prueba.test>]   # publica el curso de prueba y deja una alumna con suscripción, para ver la lección desde otro aparato de la red
pnpm db:rollup [--completo]   # corre ahora, en la base local, la consolidación de cada noche (T-207) e imprime las corridas y el consolidado del mes
pnpm team:handoff   # imprime un código para dictar y su huella, para la emergencia. No toca ninguna base
pnpm db:migration <nombre>   # crea una migración vacía en supabase/migrations/
pnpm db:orden    # que las migraciones de esta rama van después de las de main, y que no toca ninguna de main (la integración continua lo corre también)
pnpm db:turno [soltar [--forzar]]   # de quién es el turno de la base local; con dos carriles, soltarlo (abajo, «Dos carriles»)
pnpm test:db     # pruebas de base (pgTAP) de supabase/tests/, contra la base local
pnpm test:int    # pruebas de integración de tests/integration/, contra la base, el Auth y el buzón locales
pnpm test:e2e    # extremo a extremo de tests/e2e/ (Playwright): un navegador contra la aplicación compilada y la pila local
pnpm test:e2e:equipo   # el camino del equipo, de extremo a extremo: deja residuo, y rehace la base local al terminar
pnpm test:escala   # la prueba de escala de la consolidación (T-611): 13 000 alumnos en la base local; la rehace al terminar
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

`pnpm media:captions-test` le agrega al video de prueba que se le diga (por omisión, «Nature +
Forest.mp4», ya subido con `pnpm media:upload-test`) la pista de subtítulos escrita a mano,
`supabase/local/test-captions.es.vtt` (decisión de Sergio del 2026-10-15: una sola pista, en
español, en su cuenta de Mux; los automáticos se deciden con T-403). Mux no recibe el archivo:
lo descarga de una dirección pública, la del archivo en GitHub en el commit de la rama (el
repositorio es público). Por eso, antes de pedírselo, el guion lo descarga de ahí y lo compara
con el de la máquina: si la rama no está subida o el archivo cambió, se detiene. La pista
viaja con la huella del archivo: si el video ya la tiene, no hace nada, y si tiene otra pista
de prueba, se detiene (se quita a mano en el panel). Tampoco corre con `CI` ni en Vercel, ni
imprime respuestas de la API.

`pnpm db:student` deja la base local lista para ver «El bosque» como alumna con suscripción
desde otro aparato de la misma red, como el iPhone de quien revisa (T-203; decisión de Sergio
del 2026-10-19). Pide antes `db:drafts`, `media:upload-test` y `db:courses`, y no los corre él.
Publica y lista `prueba-naturaleza` como dueño de la base declarado sistema: aprobar pide a
alguien del equipo con su código, y el guardián de lo publicado acepta al dueño declarado
sistema, así que repite las revisiones, los candados y las tres escrituras de
`private.approve_course()`. Da de alta en el Auth local a `alumna@prueba.test` (u otro correo
`@prueba.test` que se le pase, sin el `it-` que barren las pruebas), la reclama y la completa
como los ayudantes de las pruebas, y le da una suscripción `manual`. Se niega con una cuenta
del equipo, invitada o de un maestro. Cada corrida le pone otra contraseña, y reclamar cierra
sus sesiones; los consentimientos son un libro, así que solo agrega los que faltan (el que nunca
se dio y el que se retiró: cuenta el último, como en la guarda), y una
suscripción viva ya vencida se extiende. Imprime la dirección con la IP de la red (sin los
adaptadores de WSL ni de Docker), el correo y la contraseña. La aplicación se levanta con
`pnpm build && pnpm start`: `next start` escucha en toda la red, y `next dev` le niega sus
recursos de desarrollo a otra dirección sin `allowedDevOrigins`. Desde otra dirección nada se
rompe en http: las cookies no llevan `Secure` con `NEXT_PUBLIC_SITE_URL` en http, y las
acciones comparan `Origin` con `Host`. Las mismas comprobaciones de `db:admins` y
`DATABASE_URL` local; de un error imprime solo el código. Deja auditoría y consentimientos:
antes de cualquier prueba, se apaga el servidor y `pnpm db:reset`.

`pnpm db:rollup` corre en la base local la consolidación de cada noche (T-207), como la corre
`pg_cron` a las 03:00: `call private.nightly_rollup()`, una llamada suelta y con el protocolo
simple, porque el procedimiento hace `commit` entre pasos. Con `--completo`, el recálculo completo
del mes en curso y el anterior (RF-408). Después imprime cómo terminó cada corrida y el consolidado
del mes en curso por alumno y lección (segundos y medios puntos), con los identificadores
recortados. Es para revisar a mano los puntos sin esperar a la noche: con `db:student`, ver una
lección entera y otra a medias, y correrlo dos veces (la entera da 2 medios puntos, la de a medias
1, y la segunda corrida deja lo mismo). Las mismas comprobaciones de `db:student`; deja corridas y
consolidado: antes de cualquier prueba, `pnpm db:reset`.

`pnpm test:escala` es la prueba de escala de la consolidación (T-611; RNF-06, RNF-07;
`tests/escala/`, el proyecto `escala` de Vitest). Carga en la base local `HORIZONTE_ESCALA`: 13 000
cuentas con suscripción y cobro (por `record_charge`), 100 maestros con 900 lecciones, 260 000
reproducciones y 9.36 millones de latidos intercalados como llegan, en el mes en curso puesto en
cierre a mano con su foto (el anterior no sirve: en una base nueva los umbrales rigen desde el
arranque). Mide con su propio reloj cada paso del recálculo completo con el consolidado vacío y
lleno, sin `analyze` y con él, sin `vacuum` y con él; la selección de antes en una muestra del
cursor; la selección sin su blindaje con plan genérico; una noche normal con 10 000 pares marcados;
y `detect_anomalies`. Al final, sobre ese mes ya consolidado, el reparto (`payout_for_period`, seis
veces seguidas, cada una con el `statement_timeout` de 10 s del servidor, y sus piezas) y el ensayo y
el cierre como los correrá el servidor: finanzas de verdad (`tests/integration/helpers/finance.ts`),
en una transacción y con el `commit` aparte. Van al final porque cerrar congela el periodo. Falla si
un recálculo pasa de 30 minutos, si un paso deja la corrida sin latir 15, si el recálculo completo no
deja el mismo consolidado que el modo marcado, o si el reparto pasa de 10 s; del ensayo y del cierre
no exige un tiempo: dice si caben (lo decide T-605, decisión de Sergio del 2026-10-26), y falla si no
ensayan o no cierran, o si lo escrito no son un bote por alumno, una parte por pareja, una
liquidación por maestro y, desde T-605, una exportación con una fila por maestro. Imprime las cifras
al final. Confirma un libro que no se borra, así que `scripts/test-escala.mjs` rehace la base al
terminar, pase o falle; si se corta, `pnpm db:reset`. No corre en la integración continua, ni a la
hora del `pg_cron` local (03:00 de la Ciudad de México), y pide la base sin nada en el mes. Las cifras
las escribe la prueba a un archivo y el guion las imprime: Vitest calla la consola de un archivo que
pasa. Desde el 2026-10-26 el Postgres local puede morir con `signal 11` a media corrida, dentro de
`private.rollup_step`, también con el código de T-602 (`../planeacion/05-esquema-backend.md` §14.4):
la prueba falla con «Connection terminated unexpectedly», y no es una falla de la regla.

Si se tocó `src/domain/access/`, `src/domain/consumption/` o `src/domain/progress/`: `test:coverage`. Ahí la cobertura es del 100 % en ramas,
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

- **Next.js 16.4** (desde el 2026-10-22, por dos avisos críticos de 16.0 a 16.4.0). Esta versión cambió respecto a las
  anteriores: su documentación exacta está en `node_modules/next/dist/docs/`, y se lee
  antes de usar una API de Next.
- **TypeScript 6.0**: el lint de TypeScript todavía no admite la 7.
- **ESLint 9**: los plugins que trae `eslint-config-next` fallan con la 10. La 9 ya no
  recibe correcciones, así que se sube en cuanto esos plugins lo permitan.

## Dos carriles

Desde la ola 0 (decisión de Sergio del 2026-10-21) puede haber dos sesiones trabajando en
paralelo, cada una en su carril y con su copia del repositorio: el carril A en `plataforma/` y
el B en `plataforma-b/`, un `git worktree` hermano. Cada tarea es una rama corta que entra a
`main` por su cuenta; la otra trae `main` antes de verificar y antes de pedir la fusión. Lo
que no se ve leyendo un solo archivo:

- **La base local es una sola, y se turna** (`scripts/db-turno.mjs`). Los guiones que la tocan
  piden el turno solos (`package.json`): pasa si es de esta copia, si está libre o si venció
  (ningún proceso que lo pidió sigue vivo y nadie lo usó en 30 minutos; un `pnpm dev` o un
  extremo a extremo vivos lo retienen), y si es de la otra copia, se niega. `test:db`,
  `test:int`, los extremo a extremo y los `db:*` que leen la base exigen además que la base
  tenga exactamente las migraciones de esta copia (las compara con
  `supabase_migrations.schema_migrations`); si no, piden `pnpm db:reset`. `dev` y `start` solo
  avisan, y van siempre en el puerto 3000: `next dev` se pasaría solo al 3001, donde los
  enlaces del Auth local y las cookies de `localhost` apuntan a la otra copia. El candado vive
  en el directorio común de git; en la integración continua no hace nada. Al terminar de
  verificar, `pnpm db:turno soltar`. Un turno que no se suelta (Windows reusa los números de
  proceso) lo suelta la copia dueña, o se borra el candado: `pnpm db:turno` dice dónde está.
- **La segunda copia se arma una vez:** `git worktree add ../plataforma-b --detach origin/main`
  desde `plataforma/`, y en ella `pnpm install`, `.env.local` y `supabase/local/test-videos.json`
  copiados de la primera (git no los trae: no se versionan).
- **Migraciones en orden.** Antes de pedir la fusión, `pnpm db:orden`. Si el otro carril
  fusionó antes una migración más nueva, la tuya se renombra (`git mv`) con la marca que el
  guion sugiere, y después `db:reset` y `test:db` otra vez. Una migración que ya está en
  `main` no se renombra ni se edita. `main` exige ramas al día antes de fusionar: al entrar una
  solicitud, la otra vuelve a correr su integración continua.
- **Lo que es de un solo carril.** Del A: `private.record_heartbeats`, `merge_progress`, la
  consolidación (`rollup_*`, `nightly_rollup`, `half_points`, `payout_thresholds`), las corridas
  (`open_job_run`, `close_job_run`), rehacer el progreso, las particiones, y las áreas del
  vigilante `watch`, `playback`, `progress`, `rollup` y las que cree. Del B: el área `catalog`,
  `saved_courses` y las áreas que cree. Congelados mientras haya dos carriles: el agregador del
  vigilante, `private.watchdog_areas()`, las áreas `base`, `ledgers`, `account` y `team`, y
  `supabase/tests/_ayuda.psql` (cada carril pone sus ayudantes en su propio archivo de prueba).
- **Lo que T-301 suma al carril A.** El libro de ingresos (`charges`, `revenue_allocations`),
  `private.record_charge`, `revenue_rule`, `revenue_amounts`, `revenue_parts`,
  `check_revenue_parts`, y tres funciones de periodo de nombre genérico que el carril B no debe
  repetir con otro sentido: `private.period_of`, `period_plus` y `period_parameter`. El área
  `revenue` del vigilante es del A.
- **Lo que T-407 suma al carril A.** El reparto (`private.compute_payout`,
  `allocate_largest_remainder`, `check_payout_lines`, `close_input_students`,
  `close_input_points`, `pool_bps`, `payout_for_period`, los tipos `private.payout_*`),
  `detect_anomalies` (ya era del A) y el área `payout` del vigilante. Con la 33 y la 34 el carril A
  agotó sus números de pgTAP: antes de su próxima prueba de base se acuerda un rango nuevo con el
  carril B.
- **Lo que T-601 suma al carril A.** Los periodos (`payout_periods`, `period_status`), las
  funciones `private.month_bounds`, `period_zone`, `period_bounds`, `period_closing_at`,
  `period_reached_closing`, `period_status_of`, `open_period`, `period_transition`,
  `allocation_start`, `guard_payout_period` y `guard_frozen_period`, la ventana
  (`rollup_window`, ya era del A), los congelados de cobros, partes, alertas y exclusiones, y el
  área `periods` del vigilante. Sus pruebas de integración nuevas van del 51 al 59 (decisión de
  Sergio del 2026-10-23: el 50 es del proxy, y la 49 fue la última del 45 al 49).
- **Lo que la segunda solicitud de T-601 suma al carril A.** Los tramos (`pool_tiers`) y las
  funciones `private.period_start`, `check_pool_tiers`, `marginal_pool_bps`, `pool_tiers_for`,
  `set_pool_tiers`, `active_students_at`, `effective_pool_bps`, `period_photos`,
  `guard_payout_timing`, `guard_pool_tier` y `guard_pool_base_origin`. Desde el 2026-10-23
  (decisión de Sergio) el A usa además pgTAP del 40 al 49, que el B no usa. `business_parameters`
  es de los dos y gana dos disparadores: `business_parameters_origin` (una versión de
  `BOTE_PCT_BASE` la escribe solo `set_pool_tiers`, porque es el tramo de 0) y
  `business_parameters_timing` (RF-707 por instante, diferido). Para el B: un parámetro del
  reparto que escriba el servidor rige exactamente desde `private.period_start()` de su periodo,
  que no ha empezado; ninguno rige hacia atrás, y como la hora es la del reloj al confirmar, uno
  que deba regir ya se programa en un instante futuro (`now()` es el inicio de la transacción, y
  ya pasó); el índice único de una versión cuenta solo las vivas, así que una cancelada no impide
  volver a programar el mismo instante; una cancelación puede quedar sin persona (la del
  sistema), y no se firma después; si el servidor cambia de rol antes de confirmar, la revisión
  falla cerrada; y una prueba que apague los disparadores de la tabla (`disable trigger user`)
  los prende antes de mirar el vigilante, que los exige.
- **Lo que T-602 suma al carril A** (primera solicitud). Las funciones `private.rollup_mode`,
  `seal_watch_partition` y `unsealed_partitions`, y `mark_pairs_for` (ya era del A). Para el B:
  `watch_rollup`, `anomaly_alerts` y `consumption_exclusions` tienen clave foránea a
  `payout_periods`, así que una prueba que escriba ahí en un mes sin fila la abre antes
  (`private.open_period()`).
- **Lo que T-602 suma al carril A** (segunda solicitud). Las tablas del cierre (`close_runs`,
  `close_run_teacher_totals`, `payout_student_pools`, `payout_shares`, `payout_teacher_totals`), las
  funciones `private.code_version`, `close_input`, `close_teacher_totals`, `rehearse_close`,
  `close_period`, `assert_period_balanced`, `check_period_balanced`, `guard_close_run` y
  `require_period_closing`, y el área `close` del vigilante. Usa pgTAP 43 y 44 e integración 53. Para
  el B: `payout_periods` tiene un disparador de restricción diferido (`payout_periods_balanced`) que
  corre cuando un periodo pasa de en cierre a cerrado. Una prueba que fuerce un estado con
  `payout_periods_guard` apagado apaga también ese, en la misma sentencia
  (`disable trigger payout_periods_guard, disable trigger payout_periods_balanced`): si no, el paso
  forzado deja su comprobación pendiente, falla al confirmar, y mientras tanto Postgres no deja otro
  `alter table` sobre la tabla («pending trigger events»).
- **La gracia es del reparto** (decisión de Sergio del 2026-10-25; `t601_gracia_del_reparto`).
  `GRACIA_COBRO_DIAS` decide quién cuenta como alumno activo, y con ello el tramo del bote: ahora
  exige `effective_period_id` y rige desde `private.period_start()` de un periodo que no ha empezado.
  Solo la sesión del dueño la pone a medio mes. Va sin el aviso de 30 días a los maestros, que la base
  no revisa. Una prueba que necesite un parámetro que no es del reparto usa `VENTANA_REEMBOLSO_DIAS`
  (así quedaron `04_parametros`, `13_invitaciones`, `41_tramos` y las integraciones 10 y 51). Para el
  B: una prueba que programe la gracia sin periodo falla con 23514, y `plataforma-b` trae `main` antes
  de verificar.
- **Los números de prueba del carril A, desde el 2026-10-25** (decisión de Sergio): además de pgTAP
  del 40 al 49 e integración del 51 al 59, el A usa pgTAP del 50 al 59 e integración del 80 al 89.
- **Lo que T-603 suma al carril A** (primera solicitud). Las tablas `payouts`, `payout_status_events` y
  `bonuses`, los tipos `payout_status`, `bonus_kind` y `bonus_status`, la columna
  `close_run_teacher_totals.founder_bonus_cents`, las funciones `private.founder_bonus`,
  `close_founder_bonuses`, `guard_payout`, `guard_bonus` y `log_payout_status`, y el área `payouts` del
  vigilante (el área `payout` de T-407 es otra). Cambian `close_input`, `rehearse_close`, `close_period` y
  `assert_period_balanced`. Usa pgTAP 45 (y amplía la 44). Para el B: un periodo cerrado de verdad ya
  tiene liquidaciones y, si hay fundadores, bonos; una prueba que borre periodos cerrados borra antes,
  en réplica, `payout_status_events`, `payouts` y `bonuses`.
- **Lo que T-603 suma al carril A** (segunda solicitud). Las tablas `payout_adjustments` y
  `teacher_balance_entries`, el tipo `balance_entry_kind`, las columnas `payout_periods.payouts_released_at`,
  `payouts_released_by` y `paid_at` y `close_runs.payout_preview`; las funciones `private.release_payouts`,
  `hold_payout`, `unhold_payout`, `capture_bonus`, `confirm_founder_bonus`, `void_bonus`, `capture_adjustment`,
  `release_payout`, `ensure_payout`, `settle_period`, `teacher_balance`, `payout_pending_teachers`,
  `first_unreleased_period`, `minimum_payout`, `assert_payout_released`, `check_payout_released`,
  `guard_payout_adjustment`, `guard_balance_entry`, `purge_watch_partition` y `purge_playback_sessions`; el procedimiento
  `private.raw_retention` y su trabajo de `pg_cron` (`raw_retention`, a las 09:45 UTC); el disparador
  diferido `payouts_released`. Cambian `guard_payout_period`, `guard_payout`, `guard_bonus`,
  `log_payout_status`, `close_period`, `rehearse_close` y `assert_period_balanced`, y `require_period_closing`
  ya no cuelga de `payouts` ni de `bonuses` (esto reemplaza lo que dice la viñeta de la primera solicitud:
  desde aquí una liquidación y un bono cambian por sus pasos). Usa pgTAP 46 a 48 e integración 55 y 57; la maquinaria de
  finanzas de las pruebas de integración vive en `tests/integration/helpers/finance.ts`. Para el B: forzar
  `'paid'` con el guardián apagado sigue sirviendo (las reglas nuevas del periodo van en su guardián, no en
  restricciones); y el `pg_cron` local borra cada mañana la partición de latidos de un periodo cerrado hace
  más de `RETENCION_LATIDOS` días.
- **Lo que T-611 suma al carril A** (primera solicitud). La función `private.rollup_full_pairs` (en el
  área `rollup` del vigilante), la prueba de escala (`tests/escala/`, `pnpm test:escala`) y el proyecto
  `escala` de Vitest. Cambia `rollup_step`. Usa pgTAP 49. Para el B: `pnpm test:escala` toma la base
  local de 10 a 20 minutos y la rehace al terminar; mientras corre, el turno es del A.
- **Lo que T-611 suma al carril A** (segunda solicitud). Ninguna función nueva: cambian
  `private.compute_payout` y `check_payout_lines`, con la misma salida (abajo, en «El reparto»). Usa
  pgTAP 50. La prueba de escala mide además el reparto, el ensayo y el cierre. Para el B: un periodo
  que esté en cierre al aplicar la migración se ensaya otra vez (`rehearsal_stale`), porque
  `code_version` entra en la huella de la entrada.
- **Lo que T-605 suma al carril A** (primera solicitud, `t605_panel_del_periodo`; decisiones de Sergio del
  2026-10-27). El servidor ensaya y cierra: `rehearse_close` y `close_period` ya son de `app_service`, y el
  área `close` del vigilante lo exige (columna `server`, como la de periodos). Las tablas
  `private.close_exports` (el CSV de cada cierre con su huella, de solo inserción) y
  `private.rollup_requests` (los recálculos pedidos desde PA-79); las funciones `private.csv_money`,
  `csv_text`, `close_export_csv`, `write_close_export` (el disparador del paso de en cierre a cerrado que
  escribe la exportación), `assert_close_export`, `close_export_download`, `finance_run_teachers`,
  `finance_periods`, `finance_period`, `finance_close` y `request_rollup`, y el procedimiento
  `private.run_rollup_requests` con su trabajo de `pg_cron` (`rollup_requests`, cada minuto). Cambia
  `check_period_balanced`: al confirmar comprueba también la exportación. Usa pgTAP 51 a 53 e
  integración 54; la 43 cambió dos aserciones (el servidor ya ensaya y cierra). Para el B: un paso a
  cerrado forzado a mano sin la corrida de un cierre del periodo no exporta, y la comprobación al
  confirmar lo rechaza (las pruebas que fuerzan el estado ya apagan `payout_periods_balanced`); una prueba
  que borre corridas del cierre borra antes, en réplica, `private.close_exports`; y el `pg_cron` local
  corre cada minuto `call private.run_rollup_requests()`, que sin pedidos no hace nada. La integración 54
  le da `app_service` a `postgres` (sin heredarlo) y se lo quita al terminar.
- **Lo que T-605 suma al carril A** (segunda solicitud, sin migración). Las pantallas PA-78 a PA-80
  (`src/app/admin/_periodos/`, servidas por el comodín: `sectionAt` acepta ahora rutas de varios
  segmentos por la tabla `DEEPER`, con la forma exacta de cada uno: `/admin/periodos/2027-10` y
  `/admin/periodos/2027-10/cierre`), su servicio (`src/services/periods/`, en CODEOWNERS, con el patrón de
  las alertas: la guarda primero, esquemas estrictos y una lista cerrada por respuesta) y cuatro
  componentes base (`DataTable`, `StatTile`, `StatusBadge` y `Dialog`), que el carril B puede usar (T-408).
  Lo que no se ve leyendo un solo archivo: ensayar y cerrar corren mientras la pantalla espera, con el tope
  de 10 s; el servicio traduce un 57014 a «tardó más de lo permitido» y un 23514 al confirmar el cierre a
  «la suma no cuadra», los dos reportados; un ensayo de hace menos de un minuto contesta `too_soon` sin
  ensayar (la revisión no toma candado: dos envíos a la vez pueden ensayar los dos); la exportación se
  descarga con su propia acción y su propio estado, y vuelve como dirección de datos (`data:text/csv`) en
  un enlace con `download`, que con JavaScript se pulsa solo: bajo administración no hay rutas, y así el
  archivo no viaja con los demás formularios sin JavaScript. El diálogo es un `<dialog open>` que pinta el
  servidor y que con JavaScript se vuelve modal (`showModal`), con Escape como «Seguir revisando». El panel
  lee además las alertas (`anomalyAlerts`) para su tabla, y si no se pudieron leer lo dice y sigue. Usa
  integración 56 (el almacén contra la base, en una transacción que se revierte) y, en
  `tests/e2e/equipo/camino.equipo.ts`, dos casos con meses de 2040 que llegan hasta la respuesta del cierre
  (cerrar va en orden y el mes en curso sigue abierto en ese camino). Para el B: la sección de periodos lee
  `anomalyAlerts`, así que una prueba de página que monte el comodín simula también
  `@/services/periods/periods`. Dos cosas de las revisiones del diff: los avisos de lo que salió bien viajan
  en una cookie sin periodo, así que cada pantalla los pinta solo si lo que tiene delante es lo que el aviso
  dice (`acceptedCloseNotice`, `acceptedRollupNotice`); y «Cerrar periodo» se ofrece solo si el último ensayo
  salió bien, con datos finales y con la suma cuadrada. **Límite conocido, decidido con Sergio el
  2026-10-27:** `close_period` acepta cualquier ensayo con datos finales cuya entrada sea la de ahora, y
  la pantalla muestra el último; si la entrada vuelve a la de un ensayo anterior (se revierte una exclusión
  y se recalcula), o alguien ensaya entre abrir el diálogo y confirmar, se congela un reparto que quien
  confirma no vio. Lo cierra la solicitud corta que sigue a esta, con migración: confirmar lleva el ensayo
  mostrado y la base exige que sea el último y de la entrada de ahora.
- **Lo que T-605 suma al carril A** (tercera solicitud, `t605_cierre_del_ensayo_mostrado`; decisión de Sergio
  del 2026-10-27; cierra el límite de la viñeta de arriba). **`close_period` cambió de firma:**
  `close_period(p_period, p_run)`, y la de un argumento ya no existe. Quien cierra dice qué ensayo tenía a la
  vista, y la base solo cierra si ese es el último del periodo (`rehearsal_superseded`, respuesta nueva),
  salió bien con datos finales (`rehearsal_missing`) y su huella es la de la entrada de ahora
  (`rehearsal_stale`); después del cálculo, el resultado debe ser el de ese ensayo (si no, lanza `XX000`, que
  no es «la suma no cuadra»). «El último» es `private.last_rehearsal()`, por `finished_at` (`started_at` es
  `now()` y empata dentro de una transacción), y lo leen igual el cierre y `finance_close` (PA-80);
  `finance_period` y `finance_periods` (PA-79 y PA-78) toman sus cifras del último que salió bien, ordenado
  igual. Entre aplicar la migración y desplegar la aplicación, cerrar falla (la firma de un argumento ya no
  existe) y se ve como «no se supo»: se aplican seguidas. Si la aserción del resultado salta, se reporta como
  `period_change_unavailable`. En la pantalla, «Cerrar periodo» y confirmar llevan el ensayo
  (`close:AAAAMM:<ensayo>`), y el diálogo se pinta solo si su ensayo es el que se ve. `finance_period` da
  además el umbral de `ALERTA_SIN_CONSUMO_PCT` (el vigente al cerrar, si cerró) y si el bote sin consumo lo
  pasa, calculado en la base con la expresión de la alerta y solo con datos finales (decisiones de Sergio de
  ese día); en PA-79 la cifra del bote sin consumo es la del mes, y lo que pasó del anterior se dice aparte. Usa
  pgTAP 54. Cambiaron, por el requisito, la 45 y la 51 (después de un ensayo fallido se ensaya
  otra vez), la integración 53 (un cierre que espera a un ensayo en vuelo que no vio contesta
  `rehearsal_superseded`) y la llamada al cierre en todas las pruebas: las de base pasan
  `private.last_rehearsal(p)`, y las de integración y la escala el ensayo que lee la pantalla (`SHOWN`, en
  `tests/integration/helpers/finance.ts`). Para el B: una prueba que llame a `close_period` pasa el ensayo, y
  un ensayo fallido escrito a mano después de uno bueno pasa a ser el último.
- **Lo que T-210 suma al carril B** (primera solicitud, sin migración; decisiones de Sergio del 2026-10-27:
  carril rápido, «Para empezar» son los del nivel más bajo, los más nuevos primero). El catálogo del
  alumno: el servicio `src/services/browse/` (lo público se lee como sistema, filtrando a mano lo listado y
  lo vigente, y se recuerda 30 s, también cuando no se supo; el avance de cada quien, como la persona), el
  inicio nuevo (PA-20), la ficha de un curso (`/cursos/[slug]`, PA-02) y la de un maestro
  (`/maestros/[slug]`, PA-03), las dos públicas. La guarda `publicViewer` (`publicPageStep`) nunca
  redirige: con una sesión que pasa mira un alumno; sin sesión, un visitante; y con una cuenta a medias,
  suspendida o «no se supo», no se sabe quién mira (`unknown`), y la ficha va sin botón. La ficha
  del curso elige su botón en `outcomes.ts` y le pregunta a `lessonAccess` por la primera lección, sin
  firmar: solo con `allowed` o `denied` hay botón; con cualquier otra respuesta (también `no_video`, que
  es lo que da una lección del proveedor de prueba) no se sabe cuál le toca, y va sin él. En el inicio,
  «Para empezar» sale solo si se supo que no hay nada empezado. El nombre de una tarjeta con avance dice
  también lo que dice su barra, que solo se ve. Componentes base nuevos: `CourseCover` (la portada generada, con `@container` y los tokens
  `text-cover-*`, `p-cover` y `cover-N-deep`), `CourseCard`, `TeacherCard` y `Carousel` (cada tarjeta va
  en un `<li>` posicionado: el nombre `sr-only` es absoluto y sin eso ensanchaba la página). `pnpm
  db:courses` carga desde aquí ocho cursos de prueba (un video de Mux va en una sola lección; las
  repeticiones, con el de prueba) y `pnpm db:student` publica todos. Usa integración 70 y, en
  `tests/e2e/equipo/catalogo.equipo.ts`, FL-10: como lo público se recuerda 30 s, una prueba que carga
  cursos después de que otra leyó el inicio recarga hasta verlos. Para el A: el inicio ya no se titula
  «Inicio» sino «Hola, …», y «continuar viendo» es un carrusel.
- **Lo que T-605 suma al carril A** (cuarta solicitud, `t605_liquidaciones`; PA-81 mínimo; plan aprobado por
  Sergio el 2026-10-28, con la revisión independiente del diseño). **Liberar, retener y soltar cambiaron de
  firma:** `release_payouts(p_period, p_seen)` lleva la huella de la vista que se vio
  (`private.release_preview()`, la única definición de lo que liberar escribiría) y contesta `preview_changed`
  si ya no es esa; `hold_payout(p_payout, p_reason, p_seen, p_alert)` lleva el estado visto, como texto (el
  servidor no usa el tipo `payout_status`), y contesta `changed`; `unhold_payout(p_payout, p_note, p_seen)` lleva
  la huella de `private.unhold_preview()` y contesta `changed`. Las firmas de antes no existen. Liberar toma
  los candados de saldo (`teacher_balance:`) de todos sus maestros, en orden, antes de recalcular la vista, y
  soltar el de su maestro antes de comparar: así soltar una retenida de otro mes no se cuela entre ver y
  liberar (`tests/integration/58-liquidaciones.test.ts` lo prueba en los dos sentidos). El servidor ejecuta
  las cinco funciones de finanzas de PA-81 y `private.finance_payouts()`; `capture_bonus` y
  `capture_adjustment` siguen cerradas (PA-83), y el área `payouts` del vigilante tiene la columna `server`,
  en los dos sentidos. **En producción la aplicación no libera** (decisión de Sergio del 2026-10-28): con
  `APP_ENV=production` el servicio contesta `not_enabled` sin preguntarle a la base, y una prueba de
  arquitectura lo exige; T-409 lo quita. El servicio vive en `src/services/periods/payouts.ts` (con sus
  consultas en `records.ts` y su almacén en `store.ts`), y la pantalla en `src/app/admin/_periodos/payouts-*`
  (`/admin/periodos/2027-10/liquidaciones`, por `DEEPER`): un solo formulario para la tabla y liberar, cada botón
  con lo que se vio (`release:AAAAMM:<huella>`, `hold:<liquidación>:<estado>`, `unhold:` o `unhold_release:`
  con la huella de la fila); anular solo se ofrece para el bono del fundador, y el almacén lo busca entre los
  del periodo antes de anular (`void_bonus` anula cualquiera). Un 57014 al liberar o al soltar se dice como
  tiempo vencido y un 23514 al confirmar como lo liberado que no cuadra, con sus reportes (`release_timed_out`,
  `release_unbalanced`). Usa pgTAP 55 e integración 58 (y suma un caso a la 56); la 46, la 47 y la
  integración 55 cambiaron sus llamadas por el requisito, y la 47 exige además, en rondas al azar, que lo
  liberado sea lo que la vista decía. `test:escala` mide también liberar. Para el B: una prueba que libere,
  retenga o suelte pasa lo que se vio (`SEEN` en `tests/integration/helpers/finance.ts` para liberar).
- **Lo que T-210 suma al carril B** (segunda solicitud, `t210_buscar`; decisión de Sergio del 2026-10-27:
  sin acentos y por prefijo). Explorar y buscar (`/explorar`, PA-21), que pide sesión (RF-304). La columna
  `published_courses.search_tsv` sale ahora de `private.catalog_search(título || ' ' || maestro)`: la clave
  de las listas (`catalog_key`), con todo lo que no es letra sin acento o cifra como espacio, y la
  configuración `simple`, sin raíces. Las dos puntas parten igual: sin eso, el analizador hacía de «4-7-8»
  un 4 y dos negativos, y de «2.0» una pieza, y el texto exacto de un título no lo encontraba. La consulta la arma
  `private.catalog_query(q)` (solo de `app_service`): cada palabra de letras sin acento y cifras como
  principio (`:*`), todas a la vez, sin operadores de quien escribe; nula si no trae nada que buscar.
  `catalog_search` la ejecuta cualquiera porque Postgres calcula la columna con los permisos de quien escribe
  la fila, antes de los disparadores: sin eso, una escritura directa recibía «sin permiso sobre la función»
  y no el rechazo del guardián (lo vio la 18). El servicio (`explore` en `src/services/browse/`) filtra por
  práctica, maestro y nivel lo listado que ya se recuerda, y la búsqueda se le pregunta a la base
  (`searchCatalog`) y se recuerda 30 s por texto; un filtro que no nombra una opción con cursos no se aplica.
  La pantalla es un formulario GET (`next/form`) que funciona sin JavaScript; con él, busca al dejar de
  escribir 400 ms y al cambiar un filtro (con la misma pausa: las flechas sobre una lista cerrada cambian
  con cada tecla), sale ya al dejar el campo con un envío pendiente, y no busca lo que ya se muestra. Los
  campos vacíos no viajan en la dirección: se quedan sin `name` durante el envío, nunca `disabled`, que en
  un navegador les quita el foco (jsdom no lo hace: la prueba exige que ninguno se apague). El buscador
  es hijo directo de `<main>`, para quedarse fijo arriba en el teléfono, y los filtros se le unen con
  `form`. Next no mueve el foco al navegar: si lo pulsado se fue con la respuesta, lo toma el buscador. Explorar entra a la
  barra del alumno, y el inicio gana «Ver todo» en «Para empezar» (al nivel) y en cada práctica. Usa pgTAP
  35, la integración 70 y, en `tests/e2e/equipo/catalogo.equipo.ts`, FL-11 con JavaScript y sin él. Para el
  A: la columna de búsqueda cambió de definición; ninguna pieza del A la lee.
- **Lo que T-110 suma al carril A** (`t110_textos_legales`; PA-89; decisiones de Sergio del 2026-10-28: la cadena
  T-110, T-401 y T-409 va en el A, los textos provisionales siguen siendo los borradores de versión 0 de local, PA-89
  publica nueve tipos y una versión nueva del consentimiento del historial se vuelve a pedir). **El servidor ya no
  inserta en `legal_documents`:** de la versión 1 en adelante publica `private.publish_legal_document(tipo, título,
  cuerpo, día, versión vista)`, con la puerta de configuración y código reciente (`team_change_gate`, la de los
  parámetros), el candado del tipo (`legal_document:`) en read committed, la versión que pone la base (la última más
  uno) y `changed` si la vista no es la última; el día es de `ZONA_HORARIA_PERIODO` (hoy rige al publicar, otro día a
  su medianoche, uno pasado contesta `past`, a lo más 366 días). El guardián (`guard_legal_document`) decide quién
  vuelve a aceptar por el tipo (términos, los dos avisos y el historial sí; lo demás no), sin importar lo que mande
  quien inserta, y desde la versión 1 solo deja insertar al dueño de la tabla. Dos lecturas solo para configuración:
  `private.legal_documents_admin()` (los nueve tipos, cada versión con su estado: `current`, `scheduled`,
  `superseded` si una más nueva rige desde antes, `previous`) y `private.legal_document_admin(id)`. El área `legal` del
  vigilante es del A. El servicio vive en `src/services/legal/admin*.ts` (lo importan las pantallas por
  `legal-admin.ts`), y la pantalla en `src/app/admin/_textos/` (`/admin/textos-legales`, y el texto de una versión en
  `/admin/textos-legales/<identificador>` por `DEEPER`): «Nueva versión» y «Ver cómo queda» no llaman a nadie, y
  «Publicar» lleva la versión vista y la huella del texto de la vista previa (`publish:<tipo>:<versión>:<huella>`); si
  el texto que llega ya no es ese, el servicio contesta `preview_stale` sin preguntarle a la base. El cuerpo de un
  texto se pinta con `src/app/_lib/legal-body.tsx`, el mismo en `/legal` y en PA-89. Usa pgTAP 56 e integración 59;
  cambiaron por el requisito la 05 (publica como el dueño a nombre de una persona, `pruebas.dueno_por`) y la
  integración 60 (publica como el dueño declarado sistema), y el guion de borradores ya no manda `requires_reconsent`.
  El ayudante de finanzas de integración (`financePerson`) arma también a alguien con configuración. Para el B: una
  prueba que publique un texto legal lo hace como el dueño de la base, y unos términos nuevos siempre se vuelven a
  pedir.
- **Lo que T-210 suma al carril B** (tercera solicitud, `t210_mi_lista`; decisiones de Sergio del
  2026-10-28: la escribe el servidor, el visitante no ve el botón, el botón va en la ficha, en el
  carrusel «Mi lista» y bajo las tarjetas de explorar, y al quitar la tarjeta se va al momento). Mi
  lista (RF-311): la tabla `saved_courses`, que la persona solo lee (la suya, por su política) y
  que escribe `app_service` (`select, insert, delete`, sin `update`). **Contra lo que planeaba el
  05:** la persona ya no escribe directo; el área `base` del vigilante, congelada, sigue permitiendo
  ese permiso, y el área `catalog` ahora lo prohíbe (la 27 cambió dos aserciones por eso). El
  guardián `private.guard_saved_course()` (antes de insertar, security definer) exige el curso
  listado y publicado y `profile_id = private.actor_id()`: un trabajo del sistema, o el dueño sin
  persona declarada, no guardan. Otro guardián, al quitar (`private.guard_saved_course_delete()`,
  sin definer: mira quién ejecuta), solo deja a quien no es el dueño de la tabla quitar filas de
  `private.actor_id()`: el servidor salta la seguridad por fila, y una consulta que olvidara a la
  persona vaciaría ese curso de todas las listas. El dueño pasa, porque el borrado en cascada corre
  como él. El vigilante exige los dos, fila por fila, antes, con su función y prendidos para las
  sesiones normales (`O` o `A`; uno en réplica no corre). La lista de un perfil borrado se va con él (`on delete cascade`;
  en producción un perfil no se borra). Un curso que deja de estar listado no se borra de ninguna
  lista: la lectura lo oculta, y vuelve si se lista otra vez. La lectura de la persona (`myList`) no
  ve el registro de cursos, así que trae solo los slugs y el servicio los cruza con lo listado que
  ya se recuerda; la ficha sabe si el curso está guardado en la misma lectura que el avance
  (`courseStanding`, que ahora contesta `saved`). Guardar y quitar (`saveCourse`, `removeCourse`)
  corren la guarda de sesión y escriben con `asServer`; la base pone a la persona. El formulario
  manda la intención (`do=save:<slug>` o `remove:<slug>`), nunca «cambiar»: un doble envío no se
  anula. Hay una acción por pantalla (`src/app/_catalog/my-list/actions.ts`), con su tabla: sin
  JavaScript vuelve a la misma pantalla en el mismo lugar (el ancla del botón, y en explorar con
  sus filtros), y con él, `refresh()`. `Button` ganó `pending`: en camino sin deshabilitarse, para
  no soltar el foco. En el carrusel del inicio, al quitar, el foco pasa al «Quitar» siguiente, al
  anterior o al contenido, salvo si la persona se fue a otra cosa mientras esperaba (la regla del
  bloque de sesiones de la cuenta). Usa pgTAP 36, integración 71 y, en
  `tests/e2e/equipo/catalogo.equipo.ts`, FL-11 paso 6 con JavaScript y sin él. Para el A: nada que
  le toque; `tests/architecture/browse.test.ts` es nueva.
- **Lo que T-401 suma al carril A** (primera solicitud, `t401_maestro_activo`; decisión de Sergio del
  2026-10-29: va antes que T-402, con el contrato que pidió el carril B). `private.current_active_teacher_id()`
  da el maestro de quien actúa (`private.actor_id()`: la persona por su sesión o la que declara el servidor)
  solo si el maestro está `active` y su cuenta también, y **toma su fila para compartir** (`for share`, por eso
  es volátil): escribir a su nombre y suspender al maestro van uno tras otro. La fila de la cuenta no la toma:
  suspender la cuenta no espera. **Solo dentro de una escritura:** ningún rol de la aplicación la ejecuta (la
  llaman las funciones del dueño), y para leer está `current_teacher_id()`, porque un candado de fila falla
  en una transacción de solo lectura. **El orden de candados** de toda función que escribe a nombre del
  maestro: primero esa fila (llamando a la función, antes de tocar `course_registry`), después prácticas,
  niveles y `course_lock`; suspender toma la fila del maestro y no toca `course_lock`. `guard_publication`
  gana un solo paso, en `course_registry`: a nombre del maestro activo, el dueño de la tabla da de alta un
  borrador limpio suyo (`draft`, con la hora de la transacción, sin versión pendiente, sin abrir, sin publicar
  ni retirar) y borra un borrador suyo que nunca se publicó (`draft` y `first_published_at` nulo; es el único
  borrado que admite el guardián). Un borrador que ya tiene filas que lo nombran (un video, reproducciones)
  no se borra: ninguna de esas claves borra en cascada, y falla con 23503. Ningún cambio a su nombre, ni en
  otra tabla de lo publicado: lo demás lo siguen haciendo el sistema y Contenido, y Contenido sigue sin
  borrar. Un maestro suspendido, una cuenta suspendida o quien no es maestro no pasan: así se cumple «un
  suspendido no envía cursos». `private.audit_row_change()` busca ahora también el `course_id` de la fila
  borrada, para que el borrado tenga entidad en la auditoría. El área `teachers` del vigilante es del A. Usa
  pgTAP 57. Para el B: las tablas del borrador de T-402 no llevan `guard_publication` (si nombran a
  `course_registry` sin cascada, su borrador tampoco se borra), y la guarda del portal (`requireTeacher`) la
  construye el B en su segunda solicitud; el A le agrega después los estados de la invitación y del aviso del
  maestro.
- **Archivos que tocan los dos.** En este archivo solo se agregan párrafos y viñetas, sin
  reacomodar los que hay: resuelve quien fusiona segundo, sin tocar el texto del otro. Las listas
  de `supabase/tests/01_estructura.test.sql` no se tocan: cada carril prueba sus tablas en su
  propio archivo. Números de prueba: el A usa pgTAP del 28 al 34 e integración del 45 al 49; el
  B, pgTAP del 35 al 39 e integración del 70 al 74. `pnpm-lock.yaml` se rehace con
  `pnpm install`, nunca a mano. En `../planeacion/` cada carril edita solo la fila y la sección
  de su tarea.

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
falla. Veintiuna precisiones que la tabla no dice:

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
  - Toda página llama a la guarda que le toca (`requireSession`, `requireLessonSession`,
    `requireIncompleteSession` o `visitorOnly`, de `src/app/_lib/guard.ts`) o entra a la
    lista de públicas de `tests/architecture/screens.test.ts`. Una pantalla con sesión se
    agrega además a `SESSION_ROUTES` (`src/services/account/navigation.ts`) y atiende sus
    dos estados: cuenta suspendida (PA-35) y «no se supo» (PA-18, con «Reintentar»).
    `SESSION_ROUTES` va por prefijo; la lección (`/cursos/{slug}/lecciones/{id}`) va por
    patrón (`isLessonPath`), porque de `/cursos` cuelga también la ficha pública del curso.
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
    piden el equipo (PA-86), configuración, y las prácticas y los niveles (PA-67) y los
    cursos por revisar (PA-61 y PA-62 mínimas), Contenido.
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
  abiertas, el cambio de contraseña y la elección de subtítulos (`captionsChoice`,
  `rememberCaptions`, desde T-203). El cambio de correo espera a T-310.
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
  TRD §5.1, §5.5, §6.1 y §9.4). Es `getMediaGrant` (`src/services/media/media.ts`), y
  quien llama dice desde dónde pide, como un literal: `review` o `watch`. Le pregunta a las
  reglas del dominio (`src/domain/access/media-access.ts` y, para ver,
  `account-access.ts`) y firma con el adaptador (`src/adapters/mux/`). Lo que no se ve
  leyendo un solo archivo:
  - **Revisar** (T-108; la pantalla de revisión pide así, y una prueba lo exige): la guarda
    del equipo, y la lección leída como la persona (`asUser`: la política de Contenido es
    una segunda barrera). A quien no tiene Contenido se le contesta `refused` antes de leer
    la lección. Nunca cuenta para el reparto, aunque quien revisa además pague.
  - **Ver** (T-202; la pantalla del alumno llega con T-203): la guarda de sesión, y después
    los hechos leídos como servidor en una sola consulta, `private.media_facts()` y el
    playback id de `private.lesson_playback()`: lo que se decide y lo que se firma salen de
    la misma foto, con la hora de la base. Una cuenta no lee el video de nada, y bajo el
    servidor no hay `auth.uid()`: quien actúa sale de `private.actor_id()`. La segunda
    barrera es esa función, que solo suelta el video de una lección vigente y lista de Mux,
    en un curso publicado y listado, del maestro dueño o para Contenido. Si la regla dio
    acceso y la barrera no soltó el video, manda la barrera, y se reporta.
  - **El orden de las reglas al ver decide dinero** (decisiones de Sergio del 2026-10-15):
    cuenta suspendida, lo que no se puede ver (contesta igual que lo que no existe:
    `no_video`), sin video, el maestro dueño (en cualquier estado del curso, sin puntos),
    «no se supo» de la cuenta (`unavailable`, reportado: nunca PA-33), suscripción o gracia
    (cuentan, también en el curso abierto y también si es alguien del equipo), cortesía, el
    curso abierto con el correo verificado, y si no, `denied` con el rechazo de la cuenta
    para PA-33. `granted` lleva `basis`, `countsForPayout` y `until`: si el acceso termina a
    media lección, la dirección sigue viva hasta su caducidad pero desde `until` no cuenta
    (T-205 lo revisa en cada latido).
  - **Los hechos de la cuenta.** `subscriptions` y `courtesy_grants` existen desde T-202 sin
    nadie de la aplicación que las escriba, y el vigilante lo exige: T-302, T-303 y T-307
    abren la escritura. La suscripción de la que salen los hechos es la viva (`active` o
    `in_grace`), y si no hay, la más reciente sin contar las `pending`: una más nueva que el
    cobro dio por terminada no tapa a la que paga. Una fecha `infinity` no entra a ninguna
    de las dos tablas (sin fin es nulo): la regla la leería como «no se supo». Sin falla de cobro, la gracia no se usa y va en 0; con falla y sin
    el parámetro de esa hora, va `NaN` y la regla contesta «no se supo». Una cuenta que pasa
    la guarda sin correo verificado se reporta (`media_email_unverified`).
  - **Lo que lleva una dirección firmada** (T-203). Los dos caminos traen el menú de
    velocidades (`speeds`, de `VELOCIDAD_MIN` a `VELOCIDAD_MAX` en pasos de 0.25, con
    `playbackRates` del dominio; los dos parámetros se leen como servidor en una sola
    consulta, porque una cuenta no lee parámetros). Ver trae además `watermark`, el correo
    de quien ve para la marca de agua, de `private.media_facts()` (`viewer.email`, de
    `auth.users`, en la misma foto): no del token, que tendría el correo de antes de un
    cambio. Sin un correo que sirva (`watermarkText`: texto con arroba, sin caracteres de
    control y de largo acotado; no `parseEmail`, que podría dejar sin video a quien pagó) no
    hay video: `unavailable`, reportado (`media_watermark_unavailable`). Se mira solo con el
    acceso ya dado: a quien no lo tiene se le dice PA-33, no «no se pudo». Revisar no lleva
    marca (llega con T-405) y ya no habla de la base ni de la cuenta: `ReviewGrant` es su
    propio tipo, no un recorte del de ver.
  - **Decidir sin firmar** (T-203): `lessonAccess(reader, lessonId)` contesta `allowed`,
    `denied`, `suspended`, `no_video`, `refused` o `unavailable`, lo mismo que contestaría
    ver, porque comparte con él la decisión (`decideWatch`) hasta antes de firmar. Es lo que
    la página de la lección pregunta al cargar, para pintar PA-33 sin pedir un video. No lee
    las velocidades, no mira la marca, no firma y nunca devuelve el playback id ni la base
    de acceso: la prueba de arquitectura lo exige.
  - Lo que no tiene video que firmar (no existe, retirada, de prueba, sin terminar, un id
    sin forma) contesta igual, `no_video`. El playback id sale de la base, nunca de quien
    pide. T-202 no anota la reproducción ni cuenta las simultáneas (T-204), y los recursos
    (RF-308) firmarán por esta misma función (T-404).
  - Firma tres direcciones (video, miniatura y vista de avance) con un JWT RS256 hecho con
    `node:crypto`, sin dependencia. La vida es la de ADR-27: la lección entera a
    `VELOCIDAD_MIN` más diez minutos, con tope de 55 (`grantLifetimeSeconds`).
  - La llave de firma (`MUX_SIGNING_KEY_ID`, `MUX_SIGNING_PRIVATE_KEY`) es opcional y va en
    pareja: sin ella no hay video y lo demás funciona; falta o no sirve, se reporta
    (`media_grant_unavailable`). Fuera de local todavía no se carga (decisión del
    2026-10-14). No va a ningún registro ni error.
  - Una prueba de arquitectura (`tests/architecture/media.test.ts`) exige que el
    adaptador y las dos variables de la llave vivan solo ahí, que ningún otro archivo de
    `src/` firme (busca las maneras de Node y del navegador, y los paquetes de JWT, y desde
    T-202 las direcciones firmadas de archivos), que para revisar la lección se lea con
    `asUser` y para ver los hechos con `asServer`, que el playback id salga solo de
    `records.ts`, que cada camino use su guarda, y que solo revisar y ver lleguen a la firma
    (`lessonAccess` no). La llave de firma es RSA de 2048 bits o
    más; una que se lee pero no firma contesta lo mismo que una que no sirve.
  - El adaptador va en `src/adapters/mux/`, no en `adapters/media/mux` como decía el TRD:
    aquí cada proveedor es su carpeta.
- **La pantalla de revisión (PA-61 y PA-62 mínimas, `/admin/revision`)** se arma como
  PA-67 (T-108; decisiones de Sergio del 2026-10-14: una sola ruta, Mux Player sin
  analítica, reproducir sin código reciente y aprobar con él). Vive en
  `src/app/admin/_revision/`. Lo que no se ve leyendo un solo archivo:
  - **Nada del video va en lo que se pinta.** La página trae la cola sin identificadores
    de Mux. Al pulsar «Ver», el navegador llama a `lessonVideoAction`, que pasa la lección
    tal cual a `getMediaGrant` (ella la revisa y corre la guarda) y devuelve el playback id
    y los tokens con los nombres de Mux Player (`playback`, no `video`: lo traduce la tabla
    de la pantalla). Una prueba de extremo a extremo revisa lo servido, no el DOM vivo:
    Mux Player escribe el playback id como atributo.
  - **El reproductor es el compartido, `src/app/_video/player.tsx`** (T-203): lo usan esta
    pantalla y, con marca de agua, la de la lección. Abajo, en su propia viñeta.
  - **Un error de Mux que no es fatal** (reconectando, sin red un momento) no se toca: lo
    resuelve Mux. El error viene en `event.detail`, con `fatal` y `muxCode`.
  - **Si la dirección caduca** (fatal, `muxCode` 2403210), se pide otra una sola vez, desde
    el mismo segundo; si vuelve a caducar sin haberse reproducido, se dice el error. Mientras
    se renueva, otro aviso de caducidad no pide otra, y un error manda sobre la dirección que
    llegue tarde. La dirección nueva llega con otro número de concesión y no se sale de la
    pantalla completa (abajo, en el reproductor). Ningún error de Mux sale del reproductor: algunos mensajes traen el
    playback id. Y el filtro de Sentry (`scrub.ts`) deja de toda dirección de Mux solo el
    servidor (`https://stream.mux.com/[video]`): el rastro de un error llevaría el playback
    id en la ruta.
  - **Aprobar** va en dos pasos dentro del curso, con un solo estado para toda la cola. La
    pregunta toma el foco (el botón pulsado se va con ella) y sigue a la vista mientras el
    envío va en camino. Aprobado, la acción redirige a la misma página con el aviso
    `course_approved` (lista cerrada de `notice.ts`): así, sin JavaScript, recargar no
    reenvía, y el aviso toma el foco si quedó sin dueño. Lo que no se pudo se dice arriba de
    la cola. «Tu código» usa el servicio del catálogo (`giveCatalogCode`): la misma puerta
    de Contenido.
  - Las lecciones se agrupan por el id de su módulo, no por su título: dos módulos pueden
    llamarse igual. Si la cola sale nula, el servicio le vuelve a preguntar a la guarda, y
    solo si insiste en que pasa se reporta (`review_queue_unavailable`).
  - Las pruebas nunca firman con la llave de verdad: `playwright.config.ts` genera una de
    prueba para la aplicación que levanta, y el extremo a extremo corta toda petición que
    no sea a ella y anota a dónde iba.
- **Una reproducción a la vez** (T-204; RF-107; decisiones de Sergio del 2026-10-19; 05
  §9.5). Ver, después de firmar, abre una reproducción con `private.open_playback()`; con el
  lugar ocupado en otro navegador de la cuenta contesta `busy` con la lista (PA-34), y se
  puede pedir cerrar una en el mismo paso (`closing`). Cada reproducción guarda la sesión de
  Auth que la abrió: desde la misma (renovar la dirección, recargar, cambiar de lección, otra
  pestaña) reemplaza a la anterior y nunca dice ocupado. «Viva» es un latido dentro de tres
  `LATIDO_SEGUNDOS`; el cupo es `SESIONES_SIMULTANEAS`; las dos salen de los parámetros
  dentro de la base. El latido de presencia es `playbackHeartbeat` (`private.touch_playback()`):
  una vencida vuelve a pasar por el cupo, una revocada dice por qué y cuál tomó su lugar
  (`revoked_by`, para «Reproducir aquí»). Cerrar una sesión de Auth suelta sus reproducciones
  con un disparador sobre `private.app_sessions`. Nadie escribe la tabla fuera de esas
  funciones, y el código no la nombra (lo exigen el vigilante y una prueba de arquitectura).
  Las dos funciones exigen read committed, y abrir mira bajo el candado que la sesión siga en
  `private.app_sessions` (`for key share`): si se cerró después de la guarda contesta
  `session_closed` y la pantalla recarga.
  La revisión del equipo no abre reproducción (la base lo impide). La dirección de Mux no se revoca: el
  reproductor se detiene porque su latido lo dice. T-205 se monta encima (la viñeta que sigue).
  Las pruebas: `supabase/tests/22_reproducciones.test.sql` (el cupo, el reemplazo, la ventana,
  la reentrada, el disparador; dos sesiones de Auth de la misma cuenta se simulan declarando
  `app.actor_session`) y `tests/integration/40-reproducciones.test.ts` (cada navegador es otra
  entrada; que abrir espera el candado se prueba con otra conexión que lo retiene: no se puede
  probar que latir también lo espera en la misma prueba, porque la transacción que abrió ya lo
  tiene).
  - **La pantalla** (segunda solicitud): el reproductor compartido avisa cuándo avanza el video
    (`onAdvancing`: el aviso `playing` de Mux, y la pausa, el final o un error lo detienen) y en
    qué segundo va (`onProgress`); la revisión no los usa. La lección late con
    `playbackPresenceAction` al empezar a avanzar, cada `heartbeatSeconds` y al volver a la
    pestaña (`visibilitychange`), y nunca mientras renueva la dirección: con la dirección nueva,
    espera a que avance el Mux Player nuevo. Reanudar seguido no late más de una vez cada 5 s, y
    `heartbeatSeconds` se acota entre 5 y 300. El latido vive en un efecto que depende de la
    reproducción: si cambia (una dirección renovada la reemplaza), la respuesta del viejo se
    descarta; y la que llega antes de que React aplique otro cambio (un error, el final) no lo
    pisa, porque se aplica solo si sigue esa reproducción en curso. PA-34 no va pegada arriba en
    el teléfono, como el reproductor: crece, y taparía la página. Cerrada o vencida con el lugar tomado, el reproductor se va
    (y con él la pantalla completa) y queda el aviso con «Reproducir aquí», o PA-34, con el
    segundo en que iba; las dos piden con `closing` (la que tomó su lugar, o la que se elige
    cerrar). El nombre del navegador sale de `src/app/_lib/devices.ts`, el mismo de PA-25. En el
    extremo a extremo el video no avanza (Mux está cortado): `advance` manda el aviso `playing`
    al elemento, y `beatNow` un `visibilitychange`, para no esperar 30 segundos.
- **Los latidos que miden** (T-205; RF-401 a RF-403; decisiones de Sergio del 2026-10-19; 05
  §5.4, §9.2 y §13.2). El latido de presencia lleva los tramos vistos que el navegador tiene
  pendientes (`playbackHeartbeat(reader, reproducción, tramos)`), y `flushHeartbeats` los manda
  sin presencia: no toma ni refresca el lugar. Un tramo es `{seq, from, to, rate, visible}`, en
  segundos enteros del video, sin la lección (sale de la reproducción) ni la hora. Lo que no se
  ve leyendo un solo archivo:
  - **El libro (`watch_events`) no lo toca nadie de la aplicación**, ni para leer: solo
    `private.record_heartbeats()`, y el código no lo nombra (lo exigen el vigilante, que mira
    también cada partición, y una prueba de arquitectura). Va por mes, sin partición por
    omisión. Las particiones las crea la migración y después `pg_cron` cada día (el trabajo
    `watch_partitions`, que llama `private.ensure_watch_partitions(2)`), con la tabla suelta y
    unida después con `attach partition`: así no detiene los latidos que entran. Cada partición
    lleva su seguridad por fila y su seguro contra vaciarla, que no pasa de la madre. El vigilante
    exige además el seguro de editar encendido en cada una, que no haya partición por omisión, y
    que exista la del mes que sigue: si `pg_cron` dejó de correr, se sabe antes de que fallen los
    latidos.
  - **La presencia y el lote van en una transacción**, la presencia primero (`recordHeartbeat`,
    en `records.ts`, que el almacén abre con `asServer` y el motivo `playback_heartbeat`). Antes
    de registrar se lee el blanco (`private.heartbeat_target()`: la lección y el tope del reloj)
    y los hechos de la cuenta, y la regla decide **a la hora del tope** si lo visto cuenta
    (`decideBeat`: `resolveAccountAccess` a esa hora, `resolveMediaAccess` y `accessCounts`).
    Lo atrasado se mide en su hora, no en la de llegada. El tope vuelve a la base tal como lo
    escribió (texto, no `Date`: perdería los microsegundos), y si ya es otro (otra transacción
    latió o revocó entre las dos lecturas) contesta `failed` y el lote se reintenta. «No se supo»
    no registra nada: el lote se queda en la cola y se reporta (`heartbeat_unavailable`).
    Guardarlo como «no cuenta» sería para siempre, porque al reintentarlo sale repetido.
  - **La base revisa cada tramo y nunca lanza por uno:** repetido (`seqs_received`, que cubre
    también el reenvío que cruza de mes), forma imposible, más allá de la duración (hasta 2 s
    se recorta) y el reloj. Lanzar abortaría la transacción con la presencia, y sin presencia el
    límite de una a la vez se cae. Cualquier otra falla (falta la partición o un parámetro) la
    ataja un bloque de excepción de plpgsql, que contesta `failed`, y la presencia de la misma
    transacción se queda. No contradice la regla del adaptador: lo que se prohíbe es atrapar en
    TypeScript; esto es una subtransacción de la base. Lo que el bloque no ataja (una consulta
    cancelada) o un error al leer los hechos sí abortan la transacción entera: `recordHeartbeat`
    no atrapa un `DatabaseError`, y `playbackHeartbeat` repite entonces la presencia sola, en
    otra transacción, para que la reproducción no venza.
  - **El reloj es el tiempo vivo** (`live_seconds`): cada presencia suma lo que pasó desde la
    anterior, a lo más una ventana. El tope es ahora, la revocación o el último latido más una
    ventana, lo que llegue primero; el presupuesto, el tiempo transcurrido (tiempo vivo + lo que
    va del último latido al tope) × `VELOCIDAD_MAX`, más 5 s de tolerancia que nunca pasan del
    tiempo transcurrido, contra lo ya aceptado. Así un dispositivo que dejó de latir mientras
    otro veía no junta tiempo para vaciarlo después (05 §15 A1), y abrir reproducciones en serie
    desde la misma sesión no junta tolerancias. La revisión contra el reloj solo vive en la base,
    la única que ve lo acumulado, bajo el candado de la cuenta. La persona no lee su tiempo vivo:
    le diría cuánto le sobra.
  - **Lo que cuenta lo calcula la base:** `qualifies` es visible y a no más de `VELOCIDAD_MAX`, y
    `counts_for_payout` pide además que la reproducción cuente y que TypeScript haya dicho que el
    acceso cuenta. Lo que dice TypeScript solo lo baja.
  - **Quién escribe:** la cuenta que abrió la reproducción y, si sigue viva, solo desde la misma
    sesión de Auth (PA-34 le muestra a otro dispositivo el id de una viva). Lo atrasado de otra
    sesión entra si la reproducción ya está revocada, con cualquier motivo, o su sesión ya no
    existe: es lo que el navegador guardó y manda al volver a entrar. Y solo si su tope cae en el
    periodo en curso o en el anterior: un periodo cerrado no cambia, y lo que sobró del
    presupuesto de una reproducción vieja no se llena después (contesta `not_found`).
  - Lo que se contesta del lote (`BatchAnswer`): `settled` con los consecutivos que salen de la
    cola (aceptados, repetidos y rechazados), `discard` (la reproducción no es de quien la manda,
    o el lote no tiene forma: lo enviado se tira) o `retry`. Las acciones son
    `playbackPresenceAction(slug, lección, reproducción, tramos)` y `flushHeartbeatsAction`. Desde
    T-206 `settled` trae además el estado de la lección (`progress`, abajo). La marca para la
    consolidación y el día de práctica los deja la base en el mismo lote (T-207, abajo); el
    navegador no se entera.
  - Las pruebas: `supabase/tests/23_latidos.test.sql` (en una transacción `now()` no avanza: el
    tiempo vivo se simula moviendo el último latido hacia atrás) y
    `tests/integration/40-reproducciones.test.ts`. Que mandar sin presencia espera el candado de
    la cuenta no se puede probar ahí, por lo mismo que latir; tampoco el mismo lote desde dos
    conexiones a la vez (lo de una transacción que se revierte no lo ve otra). Lo cubren el
    candado de la cuenta, el `for update` de la fila y `seqs_received`.
  - **El navegador** (segunda solicitud). El reproductor avisa cada muestra mientras el video
    avanza y cuándo se detiene el tramo (`onWatch`: pausa, final, búsqueda, `waiting`,
    `emptied`, un error fatal), y lo decide con el elemento en el evento mismo (`paused`), no con
    el estado de la pantalla. La pantalla arma los tramos con `segments.ts` (dominio, 100 %),
    que **nunca acredita un segundo que no se reprodujo**: un hueco de más de 1.5 s de reloj entre
    dos muestras no se puentea, un salto que no cabe en el reloj o que retrocede corta, el inicio
    de una cadena va hacia arriba y el final hacia abajo, y recorta a la duración de la concesión
    (`durationSeconds`, la que revisa la base) y a la del reproductor. Un cambio de velocidad o de
    visibilidad cierra lo de antes en su última muestra y empieza otra cadena: no se sabe en qué
    momento de en medio cambió, y así ningún segundo oculto sale como visible (lo encontró la
    revisión del diff). Ocultar la pestaña detiene la cadena (`visibilitychange`): ocultar y
    volver entre dos muestras no deja lo de en medio como visible. Mientras se
    renueva la dirección, el Mux Player viejo no suma. Las propiedades corren 500 guiones de
    reproducción al azar, en décimas de segundo (`fc.double` se va a los extremos y casi no
    reproducía nada), y exigen además que dentro de un trecho los tramos no se traslapen ni sumen
    más que el trecho, con su velocidad y su visibilidad.
  - **La cola vive en el módulo, no en la pantalla** (`watch-queue.ts`, un cartero por
    documento): navegar dentro de la aplicación desmonta la pantalla sin `pagehide`, y la
    siguiente encuentra ahí las colas. Lo puro (forma guardada, consecutivos desde 0 por
    reproducción, lotes de 50, qué quita cada respuesta, la espera de 5, 10 y 20 s hasta el
    latido, la nota a los dos fallos) está en `queue.ts`, del dominio; el navegador lo recibe por
    `src/services/media/watch-rules.ts`, la única excepción a «las pantallas piden a `media.ts`»,
    y una prueba exige que solo alcance el dominio. La memoria manda y `localStorage` es el
    respaldo: una cola se escribe entera solo con su candado (Web Locks), que la pestaña conserva
    mientras la reproducción es la actual y hasta vaciarla (la propia lo espera; una que llega
    después de soltarla se devuelve en el acto, por los efectos dobles de React); otra pestaña
    solo adopta, al abrir una lección, las colas cuyo candado consigue, y relee con él en la mano
    antes de tomarla como propia. Sin Web Locks, o si pedirlo falla, adopta las que no se escriben
    hace tres latidos: lo peor es un reenvío, que la base contesta repetido.
  - **Cuándo sale cada cosa:** el latido corta el tramo abierto y lleva la cola de su
    reproducción; si uno va en camino no sale otro (Next despacha las acciones una tras otra, y
    se apilarían). Sin presencia salen: al pausar o terminar, al ocultar la pestaña, al cambiar de
    reproducción, al irse el reproductor o la pantalla, y en los reintentos. Al irse la página
    (`pagehide`) solo se corta y se guarda. Un vaciado a la vez; el plazo de 15 s no cancela nada
    (no se puede), solo cuenta para la nota. Todo envío que deja algo sin resolver (sin respuesta,
    `retry`, o un `settled` que no lo nombra), latido o vaciado, programa el reintento: con el
    video en pausa no hay latido que lo lleve. Tras diez seguidos sin resolver (unos cuatro
    minutos) el cartero deja de reintentar solo: sin sesión, el vaciado contesta `retry` para
    siempre; lo pendiente sale con el siguiente latido, vaciado o lección. «Sin conexión.
    Reintentando…» sale con dos envíos seguidos que lanzan o no contestan a tiempo (una
    redirección no cuenta, y `retry` contestó), y se quita con el primero que contesta. Va arriba
    del reproductor en su propia región viva (junto con la del reproductor, prenderla volvería a
    decir el estado entero), y en la pantalla completa propia también abajo, sin fondo, para no
    tapar la marca, y sin anunciarse ahí. En la pantalla completa del navegador (escritorio,
    Android) no se ve: queda fuera del contenedor.
  - **Pérdidas conocidas** (RNF-05): lo que no llega a tener consecutivo (un cierre del
    navegador sin `pagehide`, un pedazo de menos de un segundo, el redondeo de las puntas), lo
    que otra cuenta del mismo navegador tira con `not_found` (al salir no se vacía la cola), y,
    si la aplicación no contesta más de tres latidos mientras Mux sigue sirviendo, lo visto en el
    hueco que pase del presupuesto (la reproducción vence y al volver su reloj crece una sola
    ventana; sale `faster_than_clock`). El video no se pausa por eso (FL-12 E5). Y en cada cambio
    de velocidad o de visibilidad con el video avanzando, menos de un segundo más lo que avanza el
    video hasta la primera muestra con lo nuevo (una muestra de `timeupdate`, unos 0.25 s, a la
    velocidad nueva: a 2×, medio segundo). La guía decía «menos de un segundo»: una corrida de las
    propiedades del 2026-10-20 lo desmintió, y la cota de la prueba se corrigió. Los huecos de
    `seqs_received` no ven las primeras.
  - Las pruebas del navegador: `segments.test.ts` y `queue.test.ts` (dominio, con
    propiedades), `watch-queue.test.ts` (almacenamiento, candados y relojes simulados),
    `tests/ui/lesson-screen.test.tsx` y `player.test.tsx`, y en `tests/e2e/equipo/leccion.equipo.ts`
    el extremo a extremo: el video de mentira define `paused`, `currentTime` y `duration` en el
    elemento y manda `timeupdate` con el reloj de verdad, porque la base revisa contra el tiempo
    vivo. Lo que solo se ve en un iPhone (ocultar y volver, cerrar Safari con un tramo abierto,
    Web Locks) se revisa a mano.
- **El progreso** (T-206; RF-307; decisiones de Sergio del 2026-10-20; 05 §5.7 y §9.2). Lo que no
  se ve leyendo un solo archivo:
  - **Lo escribe solo la base, en la transacción del libro.** `private.record_heartbeats()` le pasa
    a `private.merge_progress()` lo aceptado del lote que sirve (visible y dentro de
    `VELOCIDAD_MAX`, lo mismo que `qualifies`), el consecutivo y el final del último aceptado
    (sirva o no: la pestaña oculta también avanza el video) y el tope. `lesson_progress` guarda lo
    visto como multirrango (`covered_seconds` es una columna calculada) y la terminada al llegar a
    `UMBRAL_COMPLETO_PCT` de la duración, una sola vez y a la hora del tope. El umbral y el fundido
    viven ahí, como la base decide desde T-205 si un tramo cuenta. Nadie de la aplicación escribe
    la tabla, y el vigilante lo exige; la persona lee lo suyo sin los tramos, y el servidor no la
    lee: pregunta `private.lesson_position()`.
  - **Si el progreso falla, el libro se queda** (decisión de Sergio): va en su propio bloque de
    excepción dentro del del lote, y contesta `{outcome: 'failed'}`. El par queda en
    `private.progress_rebuilds`, el servicio lo reporta (`progress_unavailable`) y el lote sale de
    la cola: el progreso se rehace desde `watch_events` cada hora (T-207, abajo), antes de que se
    purguen las reproducciones. Sin `UMBRAL_COMPLETO_PCT`, o con uno que no es un entero
    de 1 a 10 000, es eso. Una respuesta del progreso con otra forma también cuenta como fallida
    (`records.ts` la lee aparte): no tumba el lote, que ya está en el libro.
  - **Lo atrasado no regresa a nadie.** La cola del navegador manda tarde lo de reproducciones
    viejas: los tramos se funden siempre (la unión no depende del orden), pero la posición y el
    orden de «continuar viendo» (`last_watched_at`) solo se mueven con un lote más nuevo: de la
    misma reproducción, un consecutivo mayor; de otra, un tope más nuevo. Un empate de topes entre
    dos reproducciones no mueve.
  - **El progreso está atado al video.** Si la lección cambió de video, los tramos del anterior se
    reemplazan con el primer lote del nuevo, y terminada se queda terminada. Lo guardado del video
    anterior no termina el nuevo (si el primer lote sale rechazado, sigue siendo del anterior), y
    la terminada lleva la hora de lo último visto, no la de un lote atrasado. Un lote de un video
    que la lección ya no tiene (lo atrasado) no toca el progreso: en el libro sí queda. La vista
    previa del dueño no deja progreso; la cortesía, el curso abierto y lo visto después de perder
    el acceso, sí: el progreso no mira el dinero.
  - **Lo que contesta** cada lote (`settled.progress`): `lessonId`, los segundos, si está terminada
    y si este lote la terminó, también cuando el lote salió todo repetido: un reenvío cuya
    respuesta se perdió tiene que enterarse. Nulo si no deja progreso o falló.
  - **Desde dónde arranca el video** lo trae la concesión (`startSeconds`): `getMediaGrant` lee la
    posición en la transacción que abre la reproducción, cuando lo guardado en el navegador ya
    salió (Next despacha las acciones en orden). `resumeAt` (dominio) la acota: desde el
    principio si le faltaba menos del 5 % de la lección, y al menos 10 s (decisión de Sergio).
  - **Lo que se lee** está en `src/domain/progress/` (puro, 100 %): el estado de una fila (sin
    empezar, a medias, terminada; con otro video y sin terminar, sin empezar), cuántas van y la
    lección sugerida (la última que vio si no la terminó; si no, la siguiente sin terminar; si no
    hay o ya no está, la primera sin terminar). El temario de la página de la lección lo lee con
    las lecciones, como la persona (`readCourseLessons`). «Continuar viendo» es
    `src/services/progress/` (`continueWatching`): los cursos listados que la persona empezó y no
    terminó, el más reciente primero, a lo más 20, filtrando a mano lo listado y lo vigente (y el
    tope de lo que se lee, ya sin lo terminado ni lo no listado). La tabla no tiene índice sobre lo
    que cada lote mueve: la actualización se queda en su página.
  - **Las pantallas** (segunda solicitud). El temario de PA-22 dice el estado de cada fila y,
    arriba, la barra con cuántas van. La lección arranca en `startSeconds` cuando la pantalla no
    pide otro segundo: renovar, «Reproducir aquí» y PA-34 piden el suyo, «Reintentar» sigue en el
    segundo en que iba si ya había empezado, y «Volver a ver» pide 0. Lo que cada lote contesta
    de una lección (`settled.progress`) llega a la pantalla por dos caminos, porque los dos
    envíos pasan por ella: el latido, que manda la pantalla, y los vaciados del cartero, cuyo
    `send` arma la pantalla al configurarlo (`heard`). La pantalla montada escucha
    (`progressListener`, uno por documento): lo que contesta tarde el vaciado de una pantalla que
    se desmontó le llega a la siguiente, que solo pinta las filas de su temario. Entre lo que trae
    la página y lo que oyó la pantalla manda el mayor (la página se vuelve a pintar cuando una
    acción escribe una cookie, y puede traer una terminada en otro aparato). Si el lote terminó la
    que se está viendo, con el video en curso o terminado, «Esta lección ya cuenta como
    terminada.» se dice una vez, en una región viva propia; lo que termina una cola de otra visita
    al abrir la página cambia la fila sin anunciarse. Tres límites aceptados (revisión del diff):
    la nota no trae la posición, así que un lote todo oculto deja la fila como estaba hasta
    recargar (entonces, «A medias»); «Tu avance está guardado» vale también si el progreso falló,
    porque el libro lo tiene y se rehace (T-207); y si Mux manda un `timeupdate` en 0 antes de
    saltar al segundo de arranque, un PA-34 en ese instante guardaría 0 (se revisa a mano en el
    iPhone). La barra se pinta con los colores del sistema en colores forzados. El inicio
    provisional tiene «Continuar viendo» (`continueWatching`), mínima hasta PA-20, con la barra de
    cada curso nombrada con su curso.
  - Las pruebas: `supabase/tests/24_progreso.test.sql`, `tests/integration/40-reproducciones.test.ts`
    (el progreso de punta a punta por la función única de medios),
    `tests/integration/40-leccion.test.ts` (las lecturas, con el progreso escrito por el dueño),
    `tests/ui/lesson-screen.test.tsx` y `account-pages.test.tsx` (las pantallas), y en
    `tests/e2e/equipo/leccion.equipo.ts`, guardar y volver donde se quedó, «continuar viendo», y la
    lección que se termina sin recargar (con el progreso de casi toda la lección escrito por el
    dueño, porque ver el 90 % en tiempo real tardaría minutos).
- **La consolidación nocturna** (T-207; RF-405, RF-408, RN-04; decisiones de Sergio del
  2026-10-21; 05 §5.4, §5.9, §8.2 y §13). Convierte los latidos en puntos, el insumo del reparto. Vive
  entera en la base (`t207_consolidacion`): no hay TypeScript en el camino, y por eso la regla se
  prueba en pgTAP (`supabase/tests/25_consolidacion.test.sql`, con una propiedad de tramos al azar
  contra un modelo segundo por segundo) y con mutaciones a mano, no con la cobertura de Vitest. Lo
  que no se ve leyendo un solo archivo:
  - **El latido deja la marca.** `private.record_heartbeats()` hace upsert en `private.rollup_dirty`
    (periodo, alumno, lección) con `clock_timestamp()` si aceptó un tramo con `counts_for_payout`.
    Va en el bloque del lote: si falla, el lote contesta `failed` y el navegador reintenta, porque
    perder la marca perdería consumo. Y suma en `public.practice_days` los segundos visibles
    aceptados (a cualquier velocidad, en el día del tope en `ZONA_HORARIA_PERIODO`; cortesía y
    curso abierto sí, vista previa del dueño no), en su propio bloque: si falla, esos segundos se
    pierden con un aviso en el registro de la base. Sin clave foránea a `profiles`: chocaría con el
    candado de anotar una sesión. Nadie de la aplicación lee ni escribe las tablas nuevas (lo exige
    el vigilante); la persona leerá sus días con T-505.
  - **La corrida es un procedimiento con `commit`** (`private.nightly_rollup(p_full, p_period)`),
    que `pg_cron` llama a las 09:00 UTC (03:00 de la Ciudad de México). Postgres no deja `commit`
    en un procedimiento `security definer` ni con `SET`, ni dentro de un bloque con excepción: por
    eso no los tiene, pone su `search_path` con `set_config` (y lo devuelve al terminar), y el
    trabajo de `pg_cron` es solo el `call`. Llamado dentro de una transacción, falla (2D000). Por
    cada periodo (el mes en curso y el anterior, y cada noche también los anteriores que todavía
    tengan marcas: el último día de un mes llegan latidos atrasados después de las 03:00) abre su
    corrida en `public.job_runs` (una viva por trabajo y periodo; una que no latió en 15 minutos
    queda fallida), da pasos (`private.rollup_step`, 50 pares) con `commit` después de cada uno y la
    cierra. `p_full` es el recálculo completo (RF-408), solo dentro de la ventana.
  - **Las marcas se leen sin bloquearlas y se borran solo si siguen como se leyeron.** Cada par se
    calcula en una sentencia posterior a la lectura (read committed, que `rollup_step` exige), y al
    final se borran las marcas cuyo `touched_at` no cambió: un latido que llegó en medio la cambió,
    y lo suyo entra la noche siguiente. Las marcas posteriores al arranque esperan a la siguiente
    corrida. El latido nunca espera a un paso entero.
  - **Un par** (`private.rollup_pair`): los tramos con `counts_for_payout` del periodo, unidos con
    `range_agg` por video (repetir no suma) y recortados a la duración de ese video (la menor de sus
    reproducciones, la que validó los tramos). Se queda el video con más medios puntos; después, más
    segundos; después, el vigente; al final, el id. Nunca se suman dos videos. Sin tramos que
    cuenten, la fila se borra; si nada cambió, no se escribe (`computed_at` dice cuándo cambió). Un
    par que falla no detiene a los demás: queda marcado para la noche siguiente (también en el
    recálculo completo) y la corrida termina fallida, con cuántos y el código del primero.
  - **Los medios puntos** (`private.half_points`, pura): 0, 1 o 2 con enteros, el mismo redondeo que
    el progreso. Los umbrales son los que rigen **desde el periodo** (`private.payout_thresholds`,
    por `effective_period_id`), no los de la hora en que corre: el progreso usa el de ahora y los
    puntos el del periodo, así que una lección puede quedar «terminada» sin dar 2 medios puntos. Sin
    umbral para un periodo con marcas, su corrida falla; uno sin marcas no los lee.
  - Hasta producción, que la corrida no corrió o falló solo se ve en `job_runs` (sin aviso en la
    nube). Las pruebas de integración (`tests/integration/43-consolidacion.test.ts`) llaman al
    procedimiento de verdad, con la base sin marcas: se niegan a correr si hay alguna.
  - **Rehacer el progreso que falló** (segunda solicitud, `t207_rehacer_progreso`). Cada hora, a
    la media, `pg_cron` llama `private.rebuild_progress()`, otro procedimiento con `commit` (uno
    por par, con su corrida en `job_runs`, trabajo `progress_rebuild`, sin periodo). Recorre
    `private.progress_rebuilds` (lo anotado antes de arrancar, lo más viejo primero) y rehace
    cada par con `private.rebuild_pair()`: toma el candado de la cuenta, el del latido, sin
    esperar (ocupado, se queda para la hora siguiente), y vuelve a fundir cada reproducción del
    par con la misma `private.merge_progress()`, en el orden de su tope. Así rehacer da lo mismo
    que si no hubiera fallado, y dos veces da lo mismo. Exacto en tramos, posición y terminada;
    aproximado en las horas, porque el libro no guarda el tope de cada lote: el de una
    reproducción es el menor entre su último lote recibido, su cierre y su último latido más una
    ventana. Los tramos se leen de los meses que la reproducción pudo tocar, de su arranque a su
    último latido más una ventana. La anotación se borra solo si su `failed_at` sigue siendo el
    que leyó la corrida; si vuelve a fallar, se queda con la hora y el código nuevos; si la
    cuenta ya no existe, sale. Rehacer no toca las marcas ni los días de práctica. Las pruebas:
    `supabase/tests/26_rehacer_progreso.test.sql` y, el procedimiento de verdad,
    `tests/integration/44-rehacer-progreso.test.ts`, que solo anota cuentas que no existen.
  - **El recálculo completo elige sus pares por el índice** (T-611, `t611_pares_por_indice`). Antes,
    cada paso armaba la unión entera de los latidos y el consolidado del periodo: el recálculo crecía
    con el cuadrado del periodo. Ahora `private.rollup_full_pairs()` corta cada rama por su índice
    desde el cursor y vuelve a cortar la unión de los dos cortes; da los mismos pares en el mismo orden
    siempre que la rama de los latidos lleve su `distinct` (sin él, un par con muchos latidos llena el
    corte y el cursor salta los que siguen). Va en su propia función por una razón: lleva
    `plan_cache_mode = force_custom_plan`, porque con el plan genérico que Postgres guarda tras unas
    llamadas el límite se estima como una parte de la tabla y vuelve el recorrido de la partición
    entera, y ese ajuste no debe alcanzar a `rollup_pair`. La prueba es
    `supabase/tests/49_pares_por_indice.test.sql`, contra la selección de antes copiada como oráculo.
    Tres mutaciones sobreviven: quitar el `order by` de la rama de los latidos (en el
    primer paso o con cursor) y el orden final. En todo plan que Postgres arma ahí esa salida ya viene
    ordenada (del índice, o del orden que pide la unión), y la prueba no tiene cómo forzar otro: apagar
    a la vez los índices y el orden lo devuelve a los índices.
- **Las exclusiones y las alertas de anomalía** (T-208; RF-404, RF-406, RN-08, RN-17; decisiones
  de Sergio del 2026-10-21; 05 §5.4 y §8.2). Viven en la base (`t208_anomalias_y_exclusiones`), y
  se prueban en pgTAP (`28_exclusiones`, `29_anomalias`) y con mutaciones a mano. Lo que no se ve
  leyendo un solo archivo:
  - **Una exclusión es una regla, no un borrado** (`public.consumption_exclusions`): por cuenta,
    por reproducción o por tramo de una lección, con autor y motivo; el latido no se toca.
    `private.rollup_pair()` la resta en la misma sentencia que lee los tramos, junto con
    `profiles.suspended_for_fraud` (una cuenta suspendida por fraude no cuenta nada en los
    periodos abiertos). Crearla, revertirla o cambiar esa marca marca en `rollup_dirty` los pares
    que cambian (`private.mark_pairs_for()`: salen del libro y del consolidado, para que revertir
    restaure; una marca que ya estaba se renueva, para que un paso que la leyó antes no la borre).
  - **Las decisiones son de finanzas** (`exclude_consumption`, `revoke_exclusion`,
    `review_alert`): `security definer`, solo para `app_service`, con su puerta
    (`private.finance_change_gate()`: la capacidad y el código reciente), un candado por cuenta y
    una lista cerrada de respuestas. Excluir por fraude exige una alerta del mismo periodo
    decidida como fraude, con evidencia, y una cuenta relacionada con ella. Fuera de la ventana
    del latido no se toca nada (hasta T-601). **La marca `suspended_for_fraud` ya no la escribe
    el servidor:** la prenderá solo una decisión de fraude de finanzas (T-307), no soporte.
  - **Las alertas las abre la corrida** (`private.detect_anomalies()`, paso 7 de 8.2), como el
    sistema y una sola vez por periodo, tipo y sujeto: lecciones imposibles en cada periodo de la
    ventana (red de seguridad) y el salto de puntos solo en el mes anterior terminado, con el piso
    `ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS`. Los parámetros se leen solo si hay algo que evaluar. Si
    falla, la corrida lo anota (`anomalies_failed`) y termina fallida. De una alerta cambia solo su
    revisión, una vez, y la decisión de fraude, que no se deshace; de una exclusión, solo su
    revocación. Nadie de la aplicación toca las dos tablas: el vigilante lo exige
    (`schema_violations_anomalies`).
- **La pantalla de las alertas (PA-68 mínima, `/admin/alertas`)** (T-208, segunda solicitud;
  decisiones de Sergio del 2026-10-22: una sola dirección, y de cada cuenta la antigüedad y lo que
  aporta, por tramos). Pide Finanzas (PA-88 a quien no la tiene). Vive en
  `src/app/admin/_alertas/`, con su servicio en `src/services/anomalies/` (en CODEOWNERS) y su
  lectura en la base (`t208_alertas_lectura`, pgTAP `30_alertas_lectura`). Lo que no se ve leyendo
  un solo archivo:
  - **De una cuenta solo viaja su huella en esa alerta** (`private.alert_account_token()`: 12
    caracteres de un SHA-256 con una llave que vive en la base, distinta por alerta), nunca su
    identificador, su correo ni su nombre, hasta que exista el alias del alumno (T-408). Excluir
    desde la pantalla manda la huella, y la base la resuelve contra las cuentas de esa alerta
    (`private.exclude_alert_account()`; si no es de ninguna, `not_found`). El servicio lee la
    respuesta con un esquema estricto, y una prueba de arquitectura exige que ni el servicio ni la
    pantalla nombren un identificador de cuenta.
  - **Una sola lectura** (`private.finance_alerts()`): nula sin Finanzas, con `fresh_code` y hasta
    50 alertas (las abiertas de cualquier periodo y las revisadas de los que todavía reciben
    latidos). De lecciones imposibles, su cuenta con totales; del salto, las diez cuentas que más
    le aportan a esa maestra y las ya excluidas por la alerta. Leer no pide el código reciente.
  - **Las decisiones son un solo estado para toda la lista,** cada bloque con su formulario y el
    botón que dice qué y de cuál (`review:<alerta>`, `exclude:<alerta>:<huella>`,
    `revoke:<alerta>:<exclusión>`). Decidir fraude, excluir y revertir se confirman en dos pasos
    dentro de su lugar; confirmar sin lo que hay que escribir vuelve a preguntar sin llamar a
    nadie (`askedBy`). Lo que sale bien redirige con su aviso (`alert_reviewed`, `fraud_decided`,
    `account_excluded`, `exclusion_revoked`). Si una confirmación se cierra sin hacerse, lo escrito
    se repite en el mensaje; la nota de la revisión vuelve a su campo. Límite conocido: dar el
    código otra vez redirige, y lo que se había escrito se pierde.
  - **Decidir fraude solo se ofrece con la alerta ya revisada:** con la alerta abierta, la base
    pide la nota de la revisión y contesta `malformed` (lo encontró la revisión del diff); la
    pantalla dice que primero se revisa. Sobre una revisada no pide otra nota. El motivo «fraude»
    solo se ofrece con la alerta decidida como fraude, y una cuenta ya excluida por otro motivo se
    puede excluir encima por fraude (la base lo acepta; solo el mismo motivo es `already_excluded`).
  - Cada decisión borra el aviso con que se llegó (`clearNotice`), y la pantalla no lo pinta junto
    a otra respuesta. La nota vuelve a su campo solo cuando falló revisar (el estado `failed` dice
    qué paso falló), y no se borra con lo que contesten después otros bloques. Los campos llevan
    el tope de la base (`maxLength`).
  - Revertir recibe la exclusión, no la alerta: un formulario armado a mano podría revertir una
    exclusión de otra alerta. No es una escalada (Finanzas puede revertir cualquiera), y se
    aceptó así. «Tu código» usa su propio servicio (`giveFinanceCode`), que comprueba lo reciente
    con la lectura de las alertas.
  - `Textarea` y `Select` entraron aquí como componentes base (diseño, sección 5.3), sin contador
    ni lista con búsqueda; están en `/muestra`. Las pruebas: `tests/ui/alerts-screen.test.tsx`,
    `tests/actions/alert-actions.test.ts`, `tests/architecture/anomalies.test.ts`,
    `tests/integration/46-alertas.test.ts` y, en `tests/e2e/equipo/camino.equipo.ts`, el camino
    con JavaScript y sin él.
- **El libro propio de ingresos** (T-301; RF-211, RN-02; decisiones de Sergio del 2026-10-22; 05
  §5.3). Vive en la base (`t301_libro_de_ingresos`), y se prueba en pgTAP (`31_libro_de_ingresos`,
  `32_ingresos_propiedades`, con miles de casos al azar), en integración (`47-cobros`, el mismo
  cobro a la vez desde diez conexiones) y con mutaciones a mano. Lo que no se ve leyendo un solo
  archivo:
  - **La regla vive en la base, no en TypeScript.** `private.record_charge()` registra el cobro y
    escribe sus partes en la misma transacción: el sin IVA mitad hacia arriba, el neto después de
    la comisión fija hacia abajo (`private.revenue_amounts()`), y un mensual en una parte o un
    anual en doce periodos seguidos, la última con la diferencia (`private.revenue_parts()`). No
    hay `allocateRevenue`: el reparto (T-407) lee `revenue_allocations.base_cents`. La regla se
    lee por periodo (`private.period_parameter()`, como `payout_thresholds`) y lanza si
    `IVA_EN_PRECIO`, `BASE_COMISION` o `INGRESO_POR_PERIODO` dicen otra cosa que RN-02.
  - **El cobro guarda la regla que se le aplicó** (`iva_bps`, `fee_bps`, `revenue_net_mxn_cents`),
    y la tabla la exige con sus `check`: un libro no se corrige, y una columna obligatoria no se
    agrega después (el relleno sería un `update`). Solo pesos (`charges_mxn_only`, hasta LF-07);
    `provider_event_id` nulo hasta que T-303 cree la bandeja y su clave. Las claves compuestas
    atan la suscripción a la cuenta del cobro, y cada parte a la cuenta y la comisión de su cobro;
    no hay clave directa al perfil (chocaría con el candado de `note_session`, como en
    `practice_days`). Al confirmar, `revenue_allocations_match_charge` (diferida) revisa que las
    partes de un cobro sean las de su plan, en periodos seguidos, y sumen su neto: las pruebas de
    base la ponen `immediate`, porque se revierten sin confirmar. Los identificadores del proveedor
    son ASCII visible sin espacios: con un espacio de más, el mismo cobro entraría dos veces.
  - **Nadie de la aplicación lee ni escribe los dos libros**, ni llama la función: la abre T-303
    al aviso del proveedor. Repetir un cobro contesta `already_recorded` comparando solo lo que lo
    define (cuenta, suscripción, plan, instante, moneda y monto); lo que el proveedor mande después
    no se agrega. Pide *read committed*: la segunda llamada espera a la primera en el índice único
    y tiene que ver su cobro confirmado. Las comprobaciones de forma van antes que buscar el cobro:
    `malformed`, `unsupported_currency` o `not_found` no quieren decir que el cobro no esté. El
    vigilante lo exige (`schema_violations_revenue`: las guardias de los dos libros y la de las
    partes, encendidas y no en réplica; ningún permiso; las funciones por su nombre, así que una
    sobrecarga también cuenta, y `record_charge` como dueño).
  - **Las pruebas de integración que cobren** se limpian solas: `deleteTestUsers`
    (`tests/integration/helpers/users.ts`, de los dos carriles) borra cobros, partes y
    suscripciones de las cuentas de prueba apagando las guardias dentro de su transacción.
  - Para después: los reversos (`charge_reversals`, `reversal_id` y la regla, T-307); la bandeja y
    la clave del aviso (T-303); `charges_period_fk` y el congelado de lo cerrado (T-601); la
    lectura del alumno (T-306) y la de finanzas (T-605).
- **El reparto** (T-407; RF-502, RN-03, RN-05 a RN-07, RNF-04; decisiones de Sergio del
  2026-10-23; 05 §8.4). Vive en la base (`t407_reparto`), y se prueba en pgTAP (`33_reparto`, con
  los cuatro ejemplos del PRD directos y desde sus cobros; `34_reparto_alerta_y_propiedades`, con
  tres mil periodos al azar contra un oráculo en enteros), en integración (`48-reparto`, línea por
  línea contra un oráculo en TypeScript con fast-check) y con mutaciones a mano. Lo que no se ve
  leyendo un solo archivo:
  - **No hay `computePayout` en TypeScript ni `src/domain/payout/`.** `private.compute_payout()`
    es puro (no lee tablas): recibe el porcentaje, lo arrastrado, las bases y los medios puntos, y
    devuelve líneas (`student_pool`, `share`, `unconsumed_share`, `carried_over`) con su base y sus
    medios puntos, en orden estable. `private.payout_for_period()` le arma la entrada
    (`close_input_students`, `close_input_points`, `pool_bps`): es lo que usan la alerta de cada
    noche y usarán el estimado (T-408) y el cierre (T-602). Lo arrastrado no tiene valor por
    omisión: quien llama lo pasa. Un oráculo para las pruebas no se mueve a `src/`.
  - **El redondeo es uno solo** (`private.allocate_largest_remainder()`, RN-07): cada parte hacia
    abajo y los centavos de sobra al mayor residuo, en empate al `tiebreak_rank` menor. Se calcula
    con `div` y `mod`, nunca con `floor` de una división en `numeric`, que se redondea antes del
    piso y con montos grandes se equivoca. Un peso cero no entra: un maestro con puntos y 0
    asignado se queda fuera del sin consumo. La red (`private.check_payout_lines()`) va aparte del
    cálculo para poder probarla con líneas alteradas.
  - **Sin uniones entre lo que sale de `unnest`** (T-611, `t611_reparto_lineal`). El reparto y la
    red de T-407 buscaban, por cada alumno, en todo lo que salía de `unnest`, y crecían con el
    cuadrado de los alumnos (más de siete minutos a 13 000). Postgres no sabe cuántas filas salen de
    `unnest` ni de un CTE filtrado (con el plan genérico supone 10), y una unión entre ellos la
    resuelve con un ciclo anidado: una reescritura con `left join` a agregados era rápida a 2 000
    alumnos y tardaba 43 s a 13 000. Por eso las dos son un solo `group by` por alumno (bases y
    puntos juntos con `union all`; en la red, el bote y la suma de sus partes lado a lado). El
    redondeo y los maestros de cada alumno van juntos por posición en un solo `rows from`: con dos
    laterales, según el orden de la unión, el redondeo se llamaba una vez por maestro. A 13 000
    alumnos, 2.4 s. Un cambio aquí se compara contra el reparto de T-407 copiado como oráculo en
    `50_reparto_lineal`: el mismo texto de las líneas, y con una entrada mala el mismo `sqlstate` y
    el mismo mensaje, también en un periodo de mil alumnos (con el plan que la sesión ya tenía y
    con uno a la medida) y con el planificador forzado a otros planes (el genérico, sin agregados
    con la entrada ya ordenada, sin agrupar por hash). Que siga siendo lineal lo mide
    `pnpm test:escala`.
  - **Lo que decide la regla y no se ve en el PRD**: se arrastra todo cuando lo asignado es cero,
    no solo «si nadie tuvo puntos»; el bote del alumno es el piso de la suma de sus partes por el
    porcentaje; los puntos de quien no tiene base no cuentan; un bote de 0 con puntos lleva sus
    partes de 0; y una cuenta suspendida por fraude conserva su base, que va al sin consumo
    (decisión de Sergio).
  - **La alerta del bote sin consumo** va al final de `private.detect_anomalies()` en su propio
    bloque: si falla, las otras dos alertas se quedan y la función devuelve `anomalies_failed`.
    Mira solo el mes que terminó, contra el bote sin lo arrastrado. No señala a nadie: PA-68 no
    ofrece decidirla como fraude.
  - **El vigilante** (`schema_violations_payout`) exige que cada función del reparto exista, que
    nadie de la aplicación la ejecute ni use sus tipos, que ninguna sea `security definer`, el
    `search_path` fijo, y que las tres puras sean `immutable`.
  - **La entrada es tan buena como el consolidado.** Lo que T-208 quita (una cuenta suspendida
    por fraude, una exclusión) sale del consolidado cuando la corrida procesa sus marcas: antes,
    o si su par falló, sus puntos siguen contando. Por eso el cierre (T-602) exige el periodo sin
    marcas antes de llamar a `payout_for_period()`.
  - Para después: el porcentaje por tramos y lo arrastrado guardado (T-601); escribir lo que
    devuelve el cálculo y congelarlo (T-602); el estimado del maestro (T-408); el bono y el pago
    mínimo (T-603).
- **Los periodos** (T-601, primera solicitud; RF-501; decisiones de Sergio del 2026-10-23; 05
  §8.3). Viven en la base (`t601_periodos`) y se prueban en pgTAP (`40_periodos`) y en
  integración (`49-periodos`, lo que a la vez: abrir, el candado del cobro contra el paso a
  cierre, y la corrida de cada noche). Lo que no se ve leyendo un solo archivo:
  - **La migración no escribe filas, y un mes sin fila toma su estado del reloj**
    (`private.period_status_of()`): abierto hasta su día de cierre, en cierre después. Cerrado y
    pagado solo existen con fila. Las filas las abre el paso a cierre (el mes en curso y los dos
    siguientes) y el primer cobro de un mes. Como nada cierra un periodo hasta T-602, una fila
    que se queda entra a la ventana para siempre cuando su mes termina: las pruebas de
    integración que corren la corrida quitan al terminar las filas que se crearon mientras
    corrían (`tests/integration/helpers/periods.ts`), y antes exigen la ventana de siempre. Las de
    pgTAP usan meses de 2020, 2021 y de 2030 en adelante, o abren la del mes que necesitan, y la
    que mira la ventana exacta quita las filas dentro de su transacción. El `pg_cron` de la base
    local y `pnpm db:rollup` también abren filas y pasan meses a cierre: con el tiempo, la base
    local pide `pnpm db:reset`.
  - **El mes pasa a en cierre el día `DIA_CIERRE` (3) del mes siguiente**, a las 00:00 en su
    zona: lo hace `private.period_transition()`, que la corrida de cada noche llama al terminar,
    en su propia corrida `period_transition` de `job_runs`, solo si consolidó ese mes sin error
    de paso (un par que falla no es error de paso). Primero pasa a cierre y después abre las
    filas, cada una en su bloque: si una no abre (`open_failed`), la corrida termina fallida. Con
    un solo periodo (`nightly_rollup(false, p)`) no corre. Hasta entonces el latido acepta el mes;
    en cierre ya no (contesta `not_found`, como a un mes viejo). Esto reemplaza lo que dicen las
    viñetas de T-205 («el periodo en curso o el anterior») y de T-208 («el salto solo en el mes
    anterior terminado»; «fuera de la ventana del latido»): la ventana ya no es la del latido.
  - **Una sola verdad de dónde empieza un mes**: `private.period_of()` lee la fila que contiene el
    instante y, si no hay, corta con la zona de ahora. El latido y el cobro la usan.
  - **La ventana** (`private.rollup_window()`) es el mes anterior y el en curso por reloj, más los
    periodos abiertos o en cierre que ya empezaron, menos los cerrados y los pagados. Un periodo
    en cierre se sigue corrigiendo (exclusiones, recálculo) hasta que finanzas lo cierre. Una
    fila abierta o en cierre de un mes viejo entra a la ventana.
  - **El cobro tardío.** `charges.period_id` es el mes del cobro, sin clave foránea (un mes de
    antes del arranque no tiene fila); `allocation_start_period_id` dice dónde empiezan sus
    partes, con clave. Si su mes está cerrado o pagado, o es de antes de la ventana sin fila, las
    partes empiezan en el primer periodo abierto después, con la regla `late_charge_v1` y la tasa
    de su propio mes, y `record_charge` contesta además `"late": true`.
    `private.allocation_start()` deja la fila con candado compartido: el paso a cierre espera.
  - **Lo cerrado se congela** con `private.guard_frozen_period()` (código 55000): no entra un
    cobro, una parte, una alerta ni una exclusión, ni se revierte una. Revisar una alerta sigue.
  - **El guardián** solo deja pasar de abierto a en cierre, y solo a un mes que ya llegó a su día;
    pone él `entered_closing_at`, exige los instantes del mes en una zona con nombre de lugar, y
    no deja borrar ni vaciar. Que dos periodos no se encimen lo cuida una restricción de exclusión
    (`payout_periods_no_overlap`, código 23P01), sin candado: dos que se abren a la vez no se
    esperan. Para poner un estado
    que todavía no se escribe (cerrado, pagado), una prueba apaga `payout_periods_guard` dentro
    de su transacción.
  - Para después: los tramos, la foto de los alumnos activos y RF-707 por instante (la segunda
    solicitud de T-601); cerrar y pagar, lo arrastrado, sellar y purgar las particiones,
    congelar `watch_rollup` y las claves foráneas que faltan (T-602). Con T-602 un anual tardío
    puede empezar en un mes viejo que se quedó abierto y caer con sus doce partes sobre uno ya
    cerrado: el congelado lo rechazaría y el cobro no se registraría; T-602 decide desde dónde
    empieza. Y que un mes que se queda abierto noches seguidas (`held_open`) avise.
- **Los tramos del bote** (T-601, segunda solicitud; RN-13, RF-511, RF-707; decisiones de Sergio
  del 2026-10-23: tramos marginales, con el porcentaje hacia abajo al punto base; 05 §5.5, §7.3,
  §8.3 y §8.4). Viven en la base (`t601_tramos`) y se prueban en pgTAP (`41_tramos`), en
  integración (`51-tramos`, contra oráculos en TypeScript; la `49`, la foto en la corrida) y con
  mutaciones a mano. Esto reemplaza lo que dice la viñeta de T-407 de que `pool_bps` lee
  `BOTE_PCT_BASE`. Lo que no se ve leyendo un solo archivo:
  - **Un juego se escribe entero con `private.set_pool_tiers(periodo, umbrales, porcentajes)`**,
    `security definer`, que nadie de la aplicación ejecuta todavía (PA-85 la abre): lo valida
    (el primer umbral en 0, umbrales que crecen, porcentajes de 1 a `BOTE_PCT_TECHO` que no
    bajan), cancela el juego que hubiera en ese periodo y escribe el nuevo, solo en read
    committed y con un candado consultivo. Como un parámetro, pide el código reciente a quien
    tiene configuración. El guardián de `pool_tiers` deja escribir solo al dueño de la tabla
    (desde esa función, o la sesión del dueño), pone los autores y las horas, y de un tramo solo
    deja cancelar, una vez.
  - **El tramo de 0 es el porcentaje base.** `pool_bps` ya no lee `BOTE_PCT_BASE`: la función
    escribe la versión de `BOTE_PCT_BASE` del periodo cuando no es su tramo de 0, y también la de
    cada periodo posterior con juego propio (escribir uno anterior cambia lo que heredan). El
    servidor no la escribe ni la cancela por fuera (`business_parameters_origin`).
  - **RF-707 por instante** (`private.guard_payout_timing()`, disparador de restricción diferido y
    sin `security definer`, en `business_parameters` y en `pool_tiers`): un parámetro del reparto
    rige exactamente desde el inicio de su periodo (`private.period_start()`, la única función de
    los periodos que el servidor ejecuta) y ese periodo no ha empezado; ninguno rige hacia atrás;
    no se cancela lo que ya rige; y no cambia un tramo de un periodo empezado. No lo revisa para la
    **sesión del dueño**: la que entró como el dueño de la tabla y no cambió de rol (la semilla, una
    corrección a mano). Dentro de una función `security definer` `current_user` es el dueño pero
    la sesión no, así que el servidor no hereda la excepción. Las pruebas de base la ponen
    `immediate`, porque se revierten sin confirmar. Si quien escribe no puede leer la definición
    del parámetro (cambió de rol antes de confirmar), se revisa como del reparto: falla cerrada.
    Límite: quien escribe puede adelantar la revisión, no apagarla ni posponerla. Dentro de una
    transacción, `plpgsql` no vuelve a revisar el permiso de una función que ya llamó: por eso un
    rechazo puede llegar como 23514 y no como 42501.
  - **Los alumnos activos** (`private.active_students_at(instante)`): cuentas activas y sin
    suspensión por fraude, con **alguna** suscripción no pendiente, creada a esa hora, que daba
    acceso por pago o por gracia (la lectura de `account-access.ts`, con la gracia de la hora de
    la falla: sin ella, lanza). No la sola que elige la regla de acceso, que mira el estado de
    ahora. Sin cortesías.
  - **La foto** (`private.period_photos()`): al empezar la corrida de cada noche (no un recálculo
    de un solo periodo), antes de consolidar, a cada periodo abierto o en cierre que ya terminó y no la tiene, sus alumnos
    activos en su último instante y su porcentaje (nulo sin juego de tramos), una vez, en orden y
    cada uno en su bloque. El guardián de `payout_periods` la deja escribir solo así, y sin ella
    no deja pasar de abierto a en cierre. Sin foto, el paso a cierre no pasa el periodo
    (`photo_missing`) y su corrida termina fallida; la corrida
    del paso dice también qué fotos se tomaron (`photos`). Una prueba que llame al paso a cierre
    directo escribe antes la foto, como el sistema.
  - **`private.pool_bps(periodo)`**: el guardado; si no, el de los alumnos de la foto o, sin ella,
    los de ahora o los del último instante; con los tramos marginales y **no baja**: si el periodo
    anterior tiene fila y juego, el mayor de los dos. La alerta, el estimado y el cierre leen el
    mismo número.
  - Para después: la pantalla, sus permisos y el aviso de `AVISO_CAMBIO_REPARTO_DIAS` (PA-85);
    copiar el porcentaje al cerrar y lo arrastrado (T-602); el estimado (T-408).
- **Lo que congela un periodo cerrado** (T-602, primera solicitud; RN-09; decisiones de Sergio del
  2026-10-24: el cierre va en orden, exige un recálculo completo, las liquidaciones son de T-603;
  05 §5.10, §7.3, §8.2 y §13.2). Vive en la base (`t602_congelado`) y se prueba en pgTAP
  (`42_congelado`), en integración (`52-congelado`, lo que pasa a la vez; la `49`, la corrida) y
  con mutaciones a mano. El cierre llega con la segunda solicitud. Esto reemplaza lo que dice la
  viñeta de T-601 de que las filas las abren solo el paso a cierre y el primer cobro, y lo que
  listaba para T-602 de congelar, sellar y las claves. Lo que no se ve leyendo un solo archivo:
  - **El consolidado, las alertas y las exclusiones apuntan a su periodo** (claves foráneas). La
    fila de un mes se abre justo antes de escribir en él (`rollup_pair`, la alerta del bote sin
    consumo, `exclude_consumption`), no al empezar la corrida: un mes de antes del arranque no gana
    fila, porque sin tramos nunca se cerraría y con el cierre en orden detendría a los siguientes.
  - **`guard_frozen_period` toma candado compartido sobre la fila del periodo** y mira la fila
    vieja y la nueva: el cierre, que la toma para sí (`for update`), espera a cada escritura en
    vuelo, y la que llega después lo ve cerrado (55000). Vale para los cinco congelados, ahora
    también `watch_rollup_frozen` (insertar, cambiar y borrar). `mark_pairs_for` y cada paso de la
    corrida toman el mismo candado: marcar no marca un periodo cerrado, y un paso sobre uno
    cerrado no lee nada y lo anota (`period_closed`). Una prueba que necesite un periodo cerrado
    lo fuerza con `payout_periods_guard` apagado, y declara quién actúa (la auditoría lo pide).
  - **El recálculo completo de la primera noche en cierre**: `private.rollup_mode()` decide el
    modo de cada periodo en la corrida de cada noche: completo si se pide, o si está en cierre y no
    tiene una corrida completa correcta desde que entró; y el modo completo borra las marcas de
    antes de empezar de los pares que procesó, solo si siguen como las leyó antes de consolidarlos
    (una que confirmó durante el paso se queda). El cierre (segunda solicitud) exige esa corrida.
  - **Sellar**: al final de la corrida de cada noche, `private.seal_watch_partition()` le pone a la
    partición de cada periodo cerrado o pagado una restricción `check (false) not valid`, con un
    tope de espera de 2 s por su candado exclusivo; la corrida del paso a cierre dice qué selló
    (`sealed`) y termina fallida si una no se pudo (`seal_failed`). Cada sellado confirma enseguida.
    Un recálculo de un solo periodo (`p_period`) no sella. Purgar es de T-603.
  - **Un periodo que se queda abierto dos noches seguidas** (llegó a su día y no se consolidó)
    hace que la corrida del paso termine fallida (`held_open_again`). Se mide por días en la zona
    de los periodos, no por corridas; si ayer el paso lanzó, ayer no anotó nada y hoy no avisa.
  - Límites dichos: una exclusión que se pide justo cuando su periodo se cierra contesta con el
    55000 del congelado, no con `outside_window` (revisa la ventana sin candado); y dos que abren
    la fila del mismo mes a la vez pueden chocar con la restricción de exclusión (23P01): en la
    corrida queda como un par fallido y se reintenta.
  - **`check_revenue_parts` corre como el dueño**: es un disparador diferido, corre al confirmar
    con el rol de la sesión, y el servidor (cuando T-303 abra `record_charge`) no lee los libros.
- **El ensayo y el cierre** (T-602, segunda solicitud; RF-502, RF-503, RN-09, RNF-04; decisiones de
  Sergio del 2026-10-24; 05 §5.5, §8.4 a §8.6 y §9.3). Viven en la base (`t602_cierre`) y se prueban
  en pgTAP (`43_cierre`, con el ejemplo del PRD cerrado al centavo y cada comprobación con un cierre
  descuadrado a propósito; `44_cierre_propiedades`, con quince rondas de doce meses encadenados al
  azar), en integración (`53-cierre`, lo que pasa a la vez y la comprobación al confirmar de verdad) y
  con mutaciones a mano. Nadie de la aplicación ensaya ni cierra todavía (PA-80, T-605), y **ningún
  periodo se cierra en producción antes de T-303 y T-603** (lista de salida): uno cerrado ya no se
  completa. Lo que no se ve leyendo un solo archivo:
  - **Una sola entrada, leída una vez** (`private.close_input()`): en una sentencia, las bases y los
    medios puntos ordenados, el porcentaje (en cierre, el de la foto; si no, el de ahora: el ensayo
    parcial), lo recibido del periodo anterior, los parámetros que deciden el cálculo (las dos reglas,
    el juego de tramos y los alumnos activos), el periodo y la versión del código (la última migración
    aplicada, `private.code_version()`). La huella es el SHA-256 de su `jsonb`, que escribe sus llaves
    siempre en el mismo orden; la del resultado, el de las líneas del reparto en su orden. El ensayo y
    el cierre le pasan los mismos arreglos a `compute_payout`, y lo escrito es lo que devuelve
    `payout_for_period()` con lo recibido (la 44 lo exige).
  - **El ensayo** (`private.rehearse_close()`, `security definer`, con la puerta de finanzas y solo en
    read committed) escribe su corrida (`close_runs`, de solo inserción) y el total de cada maestro,
    nada más. Con el periodo abierto es parcial, en cierre usa la foto, y cerrado contesta
    `already_closed`. No toca `payout_periods`: a un mes sin fila contesta `no_period`. Un cálculo que
    lanza queda como corrida fallida, con su error. Toma la fila del periodo con candado compartido.
  - **El cierre** (`private.close_period()`, igual de puerta y aislamiento) toma la fila para sí
    (`for update`), así que espera a cada escritura en vuelo sobre lo congelado, al ensayo y a otro
    cierre; el segundo contesta `already_closed` con el cierre que existe. Abierto o sin fila,
    `not_closing`. Las precondiciones van en orden, cada una con su respuesta y sin escribir nada:
    `before_launch` (sin juego de tramos), `previous_not_closed` (un periodo anterior, desde el
    arranque, con fila y sin cerrar; dice cuál), `photo_missing`, `no_pool_bps`, `rollup_running` (una
    consolidación del periodo con latido en los últimos 15 minutos), `last_rollup_failed` (la corrida
    más reciente desde que entró en cierre no terminó bien: falló, o se quedó colgada sin latido y
    nadie la ha dado por fallida), `needs_full_rollup` (sin una completa correcta desde que
    entró), `rollup_marks`, `open_alerts`, `rehearsal_missing` (sin un ensayo con los datos finales) y
    `rehearsal_stale` (ninguno con la huella de ahora). Después escribe la corrida, los botes de los
    alumnos, las partes y los totales en el orden de las líneas (los totales, también en su corrida),
    cierra el periodo con sus cifras (la
    hora y quién lo cerró las pone su guardián) y le pasa al siguiente lo que no se repartió
    (`carried_in_cents`, una vez y solo lo que pasó el anterior cerrado; le abre la fila si no la tiene:
    un ensayo que ya tenía queda viejo). Un cobro que confirma mientras el cierre espera cambia la
    entrada: el cierre contesta `rehearsal_stale`. Al empezar pone su comprobación en diferida: si quien
    llama la puso inmediata, correría antes de escribir lo arrastrado y el cierre fallaría.
  - **La comprobación al confirmar** (`payout_periods_balanced`, diferida; la función del disparador
    es `security definer` porque corre con el rol de la sesión): los botes de los alumnos y sus bases
    suman lo del periodo; cada alumno con puntos reparte su bote; lo asignado es la suma de las partes;
    cada maestro con partes tiene su total y sale de ellas; RNF-04 al centavo; lo que pasa al siguiente
    llega; la corrida del cierre dice las mismas cifras y tiene un ensayo con los datos finales, la
    misma huella de entrada y el mismo resultado; y lo escrito es lo que calcula el reparto con lo
    escrito (bases, medios puntos, porcentaje y lo recibido), línea por línea, con la huella de resultado
    de la corrida: así tampoco pasa un centavo movido entre dos partes del sin consumo o entre dos botes
    sin puntos. Las liquidaciones (la 6 del 05) llegan con T-603. En pgTAP nada confirma: las
    pruebas la adelantan (`set constraints payout_periods_balanced immediate`) y, para descuadrar lo
    escrito, ponen la sesión en réplica (`set local session_replication_role = replica`: Supabase se lo
    deja al dueño con la sentencia, no con `set_config`), porque con la comprobación pendiente no se
    puede `alter table`.
  - **En integración**, quien ensaya y cierra es alguien de finanzas de verdad (su factor y su sesión
    del Auth local, su código dado una vez dentro de una transacción que se revierte); su capacidad y su
    factor atado se escriben en cada transacción con la sesión en réplica y se quitan igual antes de
    confirmar, para no dejar renglones de capacidades en la auditoría. Lo que el cierre escribe sí queda
    en ella. El cierre va en orden: la 53 quita antes las filas abiertas desde el arranque a las que nada
    apunta (las abre cada noche el paso a cierre del `pg_cron` local) y exige que no quede otra abierta o
    en cierre (si no, `pnpm db:reset`). La 43 y la 44 borran, dentro de su transacción, las corridas que
    ese `pg_cron` haya dejado de sus meses: si no, dependerían de la hora.
  - Límites dichos: el orden mira los periodos con fila, y un mes sin fila entre el arranque y otro no
    lo detiene (el paso a cierre abre cada noche el mes en curso y los dos siguientes, así que solo pasa
    si `pg_cron` dejó de correr meses); y la clave de `payout_student_pools` a `profiles` hace que una
    entrada a la cuenta de un alumno con base espere a que el cierre confirme (el cierre es mensual y
    corto; `watch_rollup` ya tiene la misma clave).
  - Para después: las liquidaciones, el bono, el pago mínimo, de cerrado a pagado y purgar (T-603);
    los avisos sin procesar (T-303); PA-78, PA-80, el CSV y la conciliación (T-605); el alias y el
    desglose de finanzas (T-408).
- **Las liquidaciones y el bono del fundador, al cerrar** (T-603, primera solicitud; RF-505, RF-508,
  RN-12; decisiones de Sergio del 2026-10-25; 05 §5.5, §7.3, §8.6 y §8.7). Viven en la base
  (`t603_liquidaciones`) y se prueban en pgTAP (`45_liquidaciones`, con el ejemplo del PRD y M3
  fundador; `44_cierre_propiedades`, con fundadores y regla al azar) y con mutaciones a mano. Nadie de
  la aplicación las lee todavía (T-604, T-605). Lo que no se ve leyendo un solo archivo:
  - **El cierre crea una liquidación por maestro con total**, calculada, con su total (su parte del bote
    con la del sin consumo) como subtotal y neto; y el bono de cada fundador, **propuesto**. Las dos en
    la misma transacción, con el periodo todavía en cierre (`require_period_closing` las exige así).
    Liberar, retener, capturar, confirmar y anular llegan con la segunda solicitud: hasta entonces
    ninguna de las dos cambia (23514), y no se borran ni se vacían (42501).
  - **El bono del fundador** (`private.founder_bonus`, pura): el piso del total por el multiplicador
    menos uno, en puntos base enteros (un multiplicador que no cabe, o la regla que falta o sin duración,
    lanza si hay un fundador con total); vale en los `months` periodos que empiezan en el que contiene
    `founder_since`, contando ese; no mira el estado del maestro (lo cobra suspendido o ido); si da 0 no
    hay fila. La regla se lee del periodo que se cierra: el programa se termina con un multiplicador de
    1, nunca cancelando el parámetro, y un `months` nuevo mueve la ventana de todos desde que rige.
  - **Entra a la huella**: `close_input` lleva `FUNDADOR_MULTIPLICADOR` del periodo y la lista de
    todos los fundadores con su fecha. Un cambio de fundador o de regla deja viejo el ensayo, y el ensayo
    dice el bono por maestro (`close_run_teacher_totals.founder_bonus_cents`) y en su respuesta.
  - **La comprobación al confirmar suma dos**: la 9 (cada maestro con total tiene su liquidación
    calculada, por su total y con la corrida del cierre, y no hay de más; es la 6 del 05, que aquí ya era
    otra) y la 10 (los bonos del fundador son los que da la regla con lo escrito y con la regla y los
    fundadores que guardó la corrida, propuestos; y la corrida dice el mismo bono).
  - Las retenciones y el IVA quedan en 0 hasta T-409: la lista de salida exige T-409 antes de liberar en
    producción.
- **Liberar las liquidaciones** (T-603, segunda solicitud; RF-501, RF-505 a RF-508, RN-11, RN-17; decisiones
  de Sergio del 2026-10-25; 05 §5.5, §7.3, §8.1, §9.4, §11.4 y §13). Viven en la base (`t603_liberar`) y se
  prueban en pgTAP (`46_liberar`, con el ejemplo del PRD y un mínimo de 100 MXN; `47_liberar_propiedades`,
  diez rondas al azar; `48_purga`), en integración (`55-liberar`, lo que pasa a la vez, y `57-purga`, la
  corrida diaria de verdad) y con mutaciones a mano. Nadie de la aplicación las ejecuta todavía (PA-81 a
  PA-83, T-605), y **no se libera en producción antes de T-409** (las retenciones y el IVA quedan en 0).
  Lo que no se ve leyendo un solo archivo:
  - **Liberar** (`release_payouts`) toma la fila del periodo para sí y va en orden desde el arranque
    (`previous_not_released`), con los bonos del fundador decididos y `PAGO_MINIMO` del periodo. Le da su
    liquidación a quien tiene algo pendiente (saldo, ajuste o bono confirmado) y libera cada calculada:
    bruto = lo del bote + bonos confirmados + ajustes + el saldo del maestro; si llega al mínimo (`>=` y
    mayor que 0) espera su factura, y si no queda acumulada y su bruto pasa al saldo (que puede ser
    negativo). El saldo es un libro (`teacher_balance_entries`): cada liberación aplica todo el saldo
    (renglón `applied_to_payout`) y, si acumula, escribe su bruto (`carried_forward`); uno de 0 no se
    escribe, y un renglón solo se escribe al liberar su liquidación. Cada liberación de un maestro toma un
    candado consultivo de su saldo. Dos capturas a la vez para un maestro sin liquidación en un periodo
    cerrado crean una sola (`ensure_payout`, `on conflict do nothing`).
  - **Las retenidas no se liberan**: soltar una (`unhold_payout`) la regresa al estado en que estaba, y si
    era calculada en un periodo ya liberado la libera ahí mismo. La nota de soltar queda en su historia por
    `app.reason`, que `log_payout_status` usa como nota cuando no es una retención.
  - **Pagado al instante** (`settle_period`): un periodo liberado sin nada por pagar pasa a pagado en la
    misma transacción; las vencidas de factura las suma T-604.
  - **Los bonos a mano y los ajustes** van al primer periodo sin liberar (`first_unreleased_period`): un
    bono, desde el suyo; un ajuste, desde el siguiente a su origen. Les abren la fila si no la tiene, y si
    ese periodo ya cerró, el maestro recibe su liquidación de 0 del bote. Un bono se anula mientras su
    periodo no se libere; después, con un ajuste.
  - **La comprobación de cada liberación al confirmar** (`payouts_released`, diferida, como el dueño): su
    periodo se liberó, los bonos y los ajustes son los de su periodo, el estado sigue el mínimo, los renglones del saldo son
    exactos, y el saldo del maestro **justo al liberarla** (sus renglones hasta el renglón de la historia
    que lo dice, los dos con la hora del reloj) es lo que acumuló o 0. No «la última por periodo»: soltar
    una retenida vieja la libera después de otra más nueva (la 47 lo encontró). El disparador es `after
    update`, sin columna: un `update ... of released_at` solo correría si la sentencia nombra la columna, y
    el guardián la pone él (la revisión del diff lo encontró). Si el reloj del sistema retrocede entre dos
    liberaciones del mismo maestro, la segunda falla al confirmar: falla cerrada.
  - **La purga** (`purge_watch_partition`, solo el dueño; la corre `raw_retention`, un periodo por
    transacción): con el periodo cerrado o pagado, `RETENCION_LATIDOS` desde el cierre, sin retenidas y sin
    progreso por rehacer que lea esos latidos. Borrar la partición toma el candado de la tabla madre: lo
    espera 2 s, y si no, falla ese periodo y la corrida lo dice; la fila del periodo, sin esperarla
    (`for no key update nowait`). Al final, en otra transacción, borra las reproducciones sin ninguna
    partición viva (`purge_playback_sessions`, con el periodo purgado más reciente: es idempotente y
    recoge lo que una noche anterior no alcanzó), salvo las que otra que se queda señala como la que tomó
    su lugar: así los latidos no esperan ese borrado. Devuelve al terminar los ajustes de sesión que puso.
  - Una liquidación no nace con IVA ni retenciones (llegan con T-409), y un bono a mano no abre un mes sin
    fila a más de un año (`malformed`: es un error de captura).
  - El separador de sentencias del CLI de Supabase corta una función con `case ... end` dentro de la
    condición de un `if`: calcula el `case` en una variable antes.
  - Límite dicho: `release_payouts` toma un candado consultivo por maestro y los guarda hasta confirmar;
    con miles de maestros habrá que mirar `max_locks_per_transaction`.
- **La página de una lección (PA-22, `/cursos/[slug]/lecciones/[leccion]`)** (T-203; decisiones
  de Sergio del 2026-10-15). Vive en `src/app/cursos/[slug]/lecciones/[leccion]/`, y lo que
  pinta alrededor del reproductor lo lee `src/services/lessons/`. Lo que no se ve leyendo un
  solo archivo:
  - **Quien llega sin sesión no va siempre a entrar** (flujo §6.3): si el curso es el abierto,
    a registrarse; si no, o si no se supo, a entrar (`lessonPageStep`). Por eso el paso previo
    no redirige desde la lección (`proxySignsIn`): no lee la base. Lo decide su guarda,
    `requireLessonSession`, que pregunta `courseIsOpen` solo cuando no hay sesión; lo lee como
    sistema, del registro del curso, y solo si está listado. El registro todavía no lleva el
    `volver` hasta el final; cuando exista `/planes` (T-30x), el curso normal irá ahí.
  - **El temario se lee como la persona, filtrando a mano lo listado y lo vigente**
    (`readCourseLessons`): las políticas dejan ver más al maestro dueño y a Contenido (lo suyo
    sin listar, lo retirado). Un curso sin listar, una lección retirada, una de otro curso o
    una que no existe: PA-19, igual. Lo del maestro sin listar lo verá en su vista previa
    (PA-43).
  - **PA-33 sale al cargar**: la página le pregunta a la función única de medios con
    `lessonAccess`, sin firmar, antes de pintar (`04` §6.2, paso 7). Sin «Ver planes» hasta
    que exista la pantalla de planes, ni constancias ni medallas (T-504, T-505); desde T-206 dice
    que el avance sigue ahí. Su fecha va en
    palabras desde el servidor (`longDate`). Si la sesión dejó de pasar entre la guarda y esa
    pregunta, la página vuelve a pedirse.
  - **La dirección la pide el reproductor después** (`watchLessonAction`, como el alumno). La
    tabla (`outcomes.ts`) no deja salir la base de acceso, si cuenta para el reparto ni hasta
    cuándo: son de T-204 y T-205. Suspendida o sin sesión, la acción manda a la misma página,
    donde decide la guarda.
  - **El armado** (decisiones de Sergio): en escritorio, el reproductor, el título, el curso y
    quien lo imparte, y «Sobre esta lección» como sección (es la única pestaña que queda: las
    de Recursos y Comentarios no aparecen hasta T-404 y T-501), con el temario a la derecha.
    En teléfono, el reproductor pegado arriba y las pestañas Temario y Sobre esta lección. El
    temario va dos veces en la página (una oculta por tamaño), cada una con sus propios `id`.
    El curso y el maestro van como texto, y «Regresar» va al inicio, hasta que existan sus
    fichas (T-210).
  - Al terminar, «Lección terminada», «Sigue: {lección}» y «Volver a ver», sin arranque
    automático (D-07). Sin JavaScript, el lugar del reproductor lo dice.
  - **Los subtítulos se recuerdan en la cuenta** (RF-310; decisión de Sergio del 2026-10-15):
    la página lee `captionsChoice` a la vez que `lessonAccess`, y si no se supo arrancan
    apagados (se reporta `captions_choice_unavailable`, pero no vale una página caída). La
    acción `rememberCaptionsAction` solo acepta encendido o apagado, y `rememberCaptions`
    (`management.ts`) corre la guarda y escribe en la cuenta de esa sesión. No contesta nada:
    si no se guardó, el video sigue igual.
- **Los componentes base de la lección** (`src/ui/`): `Tabs` (las flechas, Inicio y Fin
  cambian; sin JavaScript pinta todos los paneles con su título), `LessonRow` (su nombre va
  entero en un texto que solo se lee y lo visible queda fuera del árbol de accesibilidad:
  armado con fragmentos, axe marcó que no contenía lo visible; desde T-206, con sus estados) y
  `BackLink`; y desde T-206, `ProgressBar`, la barra nativa `<progress>` pintada con los tokens
  desde `theme.css` (`progress-bar`), porque el ancho de lo lleno no se puede poner sin un estilo
  en línea. Están en `/muestra`.
- **El reproductor de video es uno solo, `src/app/_video/player.tsx`** (T-108 y T-203; diseño,
  sección 5.4; RF-305, RF-312). Lo que no se ve leyendo un solo archivo:
  - **Mux Player solo se importa ahí**, y cada pantalla lo carga con `next/dynamic` sin
    servidor: pesa (unos 330 KB comprimidos) y no debe viajar con otra página. El lint
    (`noVideoPlayer`) rechaza el `import` en cualquier otro archivo, y una prueba de
    arquitectura cualquier forma de cargarlo (`import()`, `require`), su entrada `/lazy`, que
    inyecta estilos en línea, y que una pantalla lo importe en estático más allá de su tipo.
    Si la descarga falla, la pantalla lo dice como cualquier otro error, con «Reintentar».
  - **Lo que se le apaga:** Mux Data (`disableTracking`, `disableCookies`, sin `envKey`),
    recordar volumen y silencio, y el envío a otra pantalla y la imagen dentro de imagen, que
    no tienen prop: se ponen en el `<video>` interno con la referencia (`lockDown`, que llama
    `attach`), antes de que Mux Player reciba el playback id. Sin eso, en Chrome pide un
    script de Google. El navegador de prueba no trae `window.chrome`, así que el extremo a
    extremo se lo pone. **El selector de calidad no se ofrece** (la calidad es automática,
    RF-312) y sus botones de lo apagado tampoco: los esconde la clase `player-mux` de
    `theme.css` con las variables de Mux (`--rendition-menu-button: none`…), nunca un
    `style`. **Los subtítulos arrancan como la cuenta los dejó** (`captions`, que la página lee
    con `captionsChoice`): apagados salvo que la persona los haya encendido
    (`defaultHiddenCaptions`, porque Mux los enciende por omisión). Cuando los enciende o los
    apaga (el menú de Mux, la tecla C), el reproductor escucha los pedidos de subtítulos de
    media-chrome al subir por el contenedor, ya atendidos, y avisa (`onCaptionsChange`) solo si
    cambió lo que se ve. La pantalla de la lección lo guarda con `rememberCaptionsAction` y lo
    conserva al renovar la dirección.
  - **Lo que se le configura:** el menú de velocidades que da la función única de medios
    (`speeds`), saltos de diez segundos y los controles que se ocultan a los tres segundos
    (`autohide` en su controlador; Mux trae dos).
  - **Los nombres de los controles son los del diseño** («Regresar 10 segundos», «Activar
    sonido», «Pantalla completa»…), del bloque `src/messages/es/player.ts`. `labels.ts` dice
    qué clave de media-chrome lleva cada uno: las que dan el nombre accesible van en
    minúsculas, las de la etiqueta con mayúscula, y se ponen las dos. Se registran como
    `es-MX` sobre el español de media-chrome (`addTranslation` reemplaza el diccionario entero
    de un idioma, no lo mezcla), y `setLanguage("es-MX")` cae a `es` en lo que el diseño no
    nombra. media-chrome es dependencia directa en la misma versión que la de Mux Player: si
    se sube una, se sube la otra. Su botón de subtítulos es un menú (`aria-expanded`), no un
    botón con `aria-pressed` como pedía el diseño: se aceptó la diferencia.
  - **Va dentro de un contenedor propio** (`data-player-frame`, clase `player-frame`), y ese
    contenedor es el que entra a pantalla completa: se le asigna al controlador de Mux por
    propiedad (`mediaController.fullscreenElement`), al montar y al cargar los datos del
    video. Como atributo (`fullscreenElement` de React) no surte efecto: Mux lo busca por id
    antes de que el nodo esté en la página. El extremo a extremo de revisión lo comprueba en
    un navegador. Dentro, un escenario (`player-stage`) guarda el 16:9 y lleva encima la marca:
    a pantalla completa se centra a lo más grande que quepa (con unidades de contenedor), así
    que la marca queda sobre el video y no en las franjas negras.
  - **La pantalla completa dentro de la página** (iPhone; diseño, sección 5.4; D-08). Donde el
    navegador no lleva un elemento a pantalla completa (`document.fullscreenEnabled` falso),
    Mux caería a la del sistema, que no pinta la marca. Ahí el reproductor atrapa en la captura,
    sobre su contenedor, los pedidos de media-chrome (`mediaenterfullscreenrequest` y el de
    salir: su botón y la tecla F) antes de que lleguen a su controlador, y hace la suya: el
    contenedor fijo sobre toda la ventana (`player-frame-filled`, con `100dvh` y los márgenes
    seguros), la página de atrás sin desplazarse (`player-locked` en `html`), «Salir de
    pantalla completa» con el foco y, en vertical, el aviso de girar un momento y «Girar», que
    rota el contenedor 90 grados (`data-turned`). El botón de Mux se esconde mientras
    tanto. Si iOS entra solo a la del sistema (un pellizco, `webkitbeginfullscreen` en el video
    interno), sale de ella y pasa a la propia, o se queda en la propia como estaba, girada o no.
    Donde el navegador sí lleva el contenedor, nada se atrapa. Los márgenes seguros van en
    variables (`--safe-top`…) que girado cambian de lado, porque cada lado del contenedor cae
    sobre otro de la pantalla; los usan también los botones y el aviso, que van en posición
    absoluta y no se mueven con el relleno del contenedor. La franja de los botones no recibe el
    toque, solo los botones, y el aviso de girar se dice en una región viva que existe desde
    antes de entrar. El extremo a extremo lo prueba con un iPhone simulado (`likeAnIPhone`: sin
    pantalla completa de elementos y con la del video), y mide que ninguna de las ocho celdas de
    la marca quede bajo un botón, en vertical, girado y en horizontal. Chromium no simula los
    márgenes seguros: eso y el iPhone de verdad, a mano.
  - **Renovar la dirección no saca de la pantalla completa** (decisiones de Sergio del
    2026-10-19). Las pantallas no le ponen `key` al reproductor: le pasan un número de
    concesión (`grant`, el del pedido que dio la dirección), y el reproductor lo usa como `key`
    de `<MuxPlayer>`, dentro del contenedor. Con una dirección renovada solo se monta otro Mux
    Player; el contenedor (lo que está a pantalla completa), la marca y el estado de la pantalla
    completa propia se quedan. Tres cosas que no se ven: cambiar solo los tokens del mismo Mux
    Player no vuelve a cargar el video (leído en `@mux/mux-player` 3.14: guarda los tokens sin
    volver a pintar); el número no es el token, porque el token se firma con la hora en
    segundos y sin azar, y dos pedidos seguidos dan el mismo; y el elemento nuevo se liga al
    contenedor en su referencia (`attach`), y la escucha del pellizco se vuelve a poner con su
    video. Al caducar se anota lo que se repone en el nuevo al cargar: la velocidad, el volumen
    y el silencio, y el foco si estaba dentro y quedó sin dueño. El foco se le da al
    controlador de Mux, no al elemento: el elemento no lo recibe (su sombra no lo delega), y los
    atajos del teclado escuchan en el controlador; lo mismo al salir de la pantalla completa
    propia. Si sigue solo se decide al cargar, no al caducar: sigue si la persona le había dado
    reproducir y no pausó desde entonces (los pedidos de media-chrome de reproducir y pausar, el
    aviso de que empezó, y cualquier pausa que no acompañe a un error, como la de la pantalla de
    bloqueo). Safari puede negarse sin un toque sobre ese `<video>`, que es nuevo: queda en
    pausa en el segundo en que iba. El extremo a extremo provoca la caducidad a pantalla
    completa, en computadora y en el iPhone simulado.
  - **La marca de agua** (`watermark.tsx`, RF-305), solo si la pantalla la pasa (la lección;
    revisión no, hasta T-405): el correo de quien ve, tal como lo dio la función única de
    medios, en una de las ocho celdas del borde de una rejilla de 3 × 3 sobre el área segura
    (`watermark-cells.ts`, nunca la central), que cambia cada 30 segundos con un desvanecido
    y deriva despacio. Cada celda la ancla al borde del área segura según su columna y la
    deriva va hacia dentro, con un ancho máximo: así no se corta ni se sale en un teléfono
    (medido en Chromium de 320 a 1280 px; un correo de más de unos 50 caracteres en 320 px se
    corta con puntos suspensivos antes que salirse). Lleva `translate="no"`. Con movimiento reducido, la regla general de `theme.css` le quita la
    deriva. Su estilo son tokens (`--watermark`, `--watermark-size`, que mide el contenedor
    con `cqw`) y utilidades (`watermark`, `watermark-cell-N`). No se lee, no se selecciona y
    no recibe el toque. **Si desaparece, se oculta o le cambian el texto, el video se pausa**
    (`watermarkIntact`, que vigila un observador del contenedor, cada cambio de celda y cada
    vez que se le da reproducir). Mientras se desvanece y mientras vuelve, su opacidad no
    cuenta, o daría pausas falsas; tampoco mientras corre una transición de opacidad suya, que
    el navegador empieza un cuadro después de que React quita la clase y puede seguir cuando
    el periodo protegido ya terminó (lo encontró la revisión del diff, medido en Chromium). Una
    transición detenida a mano no la excusa, ni la deriva, que siempre corre. Es disuasión, no candado: ningún texto promete más.
- **Quién tiene acceso hoy lo dice una sola regla** (T-201; RN-01, RF-203; TRD §5.1):
  `resolveAccountAccess`, en `src/domain/access/account-access.ts`. No se guarda un campo
  «tiene acceso». La usa la función única de medios desde T-202. Para quien la use: los
  hechos los reúne el servicio, y el comentario del archivo dice de dónde sale cada uno
  (`paidThrough` no es el fin de periodo
  del proveedor de cobro); `invalid_input` es «no se supo» y nunca se trata como «sin
  acceso», que le pediría pagar a quien quizá ya pagó; y el orden de las bases decide
  dinero (solo suscripción y gracia generan puntos).
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
  filas, y `supabase/tests/01_estructura.test.sql` lo exige. **El vigilante va por áreas**
  (ola 0, migración `w0_vigilante_por_areas`): `private.schema_violations()` es un agregador que
  descubre en el catálogo las funciones `private.schema_violations_<área>()` y las corre; un área
  que no se puede usar (otro nombre, otro dueño, argumentos o forma) o que lanza se dice con una
  fila, y sin ninguna también. **Una regla nueva va en un área nueva, por dominio**
  (`schema_violations_anomalies` para T-208): misma firma, `language sql stable set search_path =
  ''`, sin `security definer` y con `revoke all … from public`; nunca se reescribe el agregador ni
  un área ajena. Su firma del sistema y sus libros van en su área, con el mismo texto de regla.
  `supabase/tests/27_vigilante.test.sql` provoca cada regla y prueba la mecánica; la prueba de
  cada tarea provoca las reglas de su área y exige que el área esté en `private.watchdog_areas()`
  (si se borrara, el agregador no lo notaría). Una excepción nueva a las reglas de `base` (un permiso previsto
  para una persona con sesión) va en una solicitud corta que solo cambia esa área.
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
  - Lo que la pantalla de revisión lee es `private.review_queue()` (T-108): una sola
    función, nula para quien no pasa la puerta de Contenido, con `fresh_code` y los cursos
    en revisión. Nunca trae el playback id ni el asset id: el video sale solo por la
    función única de medios.
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
  alguien devuelva el permiso (TRD §9.2). Desde T-203 está `captions_on` (si la persona dejó
  los subtítulos encendidos): la escribe el servidor por su columna, la persona solo la lee, y
  no se audita.
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
Con el video (T-108), `src/services/media/`, `src/adapters/mux/` y el servicio de
revisión, `src/services/review/`; con el reproductor compartido (T-203), `src/app/_video/`,
donde viven la marca de agua y lo que se le apaga a Mux Player; y con la página de la
lección, `src/app/cursos/` y `src/services/lessons/`; con el progreso (T-206),
`src/domain/progress/` y `src/services/progress/`.
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
un proveedor, y se pregunta. Desde la ola 0, `main` exige además que la rama esté al día antes de
fusionar (decisión de Sergio del 2026-10-21, para los dos carriles). `main` no se despliega mientras producción no exista
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
