import { Info } from "lucide";
import type { Metadata } from "next";
import Image from "next/image";
import type { ReactNode } from "react";

import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { CourseCard } from "@/ui/course-card";
import { DataTable } from "@/ui/data-table";
import { Disclaimer } from "@/ui/disclaimer";
import { Filigree, FlowerMark, Rosette, SeedMark } from "@/ui/flower";
import { FlowerState } from "@/ui/flower-state";
import { FormErrorSummary } from "@/ui/form-error-summary";
import { FullScreenState } from "@/ui/full-screen-state";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { LessonRow } from "@/ui/lesson-row";
import { ProgressBar } from "@/ui/progress-bar";

// Los estados de una fila, como los da el servicio: una prop de estado no es texto.
const COMPLETED = "completed" as const;
const IN_PROGRESS = "in_progress" as const;
import { OTPField } from "@/ui/otp-field";
import { PageHeader } from "@/ui/page-header";
import { PasswordField } from "@/ui/password-field";
import { Select } from "@/ui/select";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { Spinner } from "@/ui/spinner";
import { StatTile } from "@/ui/stat-tile";
import { StatusBadge } from "@/ui/status-badge";
import { Tabs } from "@/ui/tabs";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";
import { Textarea } from "@/ui/textarea";
import estrellas from "@/ui/photos/inicio-estrellas.jpg";
import portada from "@/ui/photos/portada-muelle.jpg";
import { Wordmark } from "@/ui/wordmark";

import { SampleFileUpload } from "./sample-file-upload";

// Página de muestra de los componentes base. Solo existe en desarrollo (ver
// next.config.ts): `pnpm dev` y http://localhost:3000/muestra.
//
// Sirve para lo que un DOM simulado no ve: el foco visible, los tamaños táctiles, los 320
// px de ancho y el movimiento reducido. Sus textos van escritos aquí porque son de
// ejemplo: es el único lugar donde el lint lo permite.

export const metadata: Metadata = { title: "Muestra de componentes" };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-border pt-8">
      <h2 className="text-h2">{title}</h2>
      {children}
    </section>
  );
}

const SWATCHES = [
  ["bg", "bg-bg"],
  ["surface-1", "bg-surface-1"],
  ["surface-2", "bg-surface-2"],
  ["surface-3", "bg-surface-3"],
  ["accent", "bg-accent"],
  ["accent-subtle", "bg-accent-subtle"],
  ["success-bg", "bg-success-bg"],
  ["warning-bg", "bg-warning-bg"],
  ["danger-bg", "bg-danger-bg"],
] as const;

const SAMPLE_COURSE = { title: "Respiración para dormir", teacherName: "Ana Robles", practice: { name: "Respiración", tone: 4 }, levelName: "Inicial", lessonCount: 6 };

const BREATH = { slug: "respiracion", name: "Respiración", tone: 4, position: 0 };
const MEDITATION = { slug: "meditacion", name: "Meditación", tone: 3, position: 1 };
const SOUND = { slug: "sonido", name: "Sonido", tone: 6, position: 2 };
const YOGA = { slug: "yoga", name: "Yoga", tone: 1, position: 3 };

/** Doce cursos de cuatro prácticas, con títulos de los tres largos (hasta 24, hasta 44 y más). */
const SAMPLE_GRID = [
  { slug: "respirar-para-dormir", title: "Respirar para dormir", teacher: "Ana Robles", practice: BREATH, level: "Inicial", lessons: 6 },
  { slug: "respiracion-cuadrada", title: "La respiración cuadrada para los días de mucho trabajo", teacher: "Ana Robles", practice: BREATH, level: "Intermedio", lessons: 9 },
  { slug: "el-aliento-del-fuego", title: "El aliento del fuego", teacher: "Tomás Ibarra", practice: BREATH, level: "Avanzado", lessons: 4 },
  { slug: "meditacion-de-la-manana", title: "Meditación de la mañana", teacher: "Lucía Peña", practice: MEDITATION, level: "Inicial", lessons: 12 },
  { slug: "atencion-plena-en-casa", title: "Atención plena en casa, paso a paso", teacher: "Lucía Peña", practice: MEDITATION, level: "Inicial", lessons: 8 },
  { slug: "el-silencio-interior", title: "El silencio interior", teacher: "Ramón Ortiz", practice: MEDITATION, level: "Avanzado", lessons: 10 },
  { slug: "sonidos-del-cuenco", title: "Sonidos del cuenco", teacher: "Inés Valle", practice: SOUND, level: "Inicial", lessons: 5 },
  { slug: "mantras-para-empezar", title: "Mantras para empezar el día con calma", teacher: "Inés Valle", practice: SOUND, level: "Intermedio", lessons: 7 },
  { slug: "el-gong-y-la-noche", title: "El gong y la noche", teacher: "Ramón Ortiz", practice: SOUND, level: "Avanzado", lessons: 3 },
  { slug: "yoga-suave", title: "Yoga suave", teacher: "Marta Celis", practice: YOGA, level: "Inicial", lessons: 10 },
  { slug: "saludo-al-sol", title: "Saludo al sol en veinte minutos", teacher: "Marta Celis", practice: YOGA, level: "Intermedio", lessons: 6 },
  { slug: "yoga-restaurativo", title: "Yoga restaurativo para la espalda y el cuello después de una semana larga", teacher: "Tomás Ibarra", practice: YOGA, level: "Avanzado", lessons: 11 },
];

export default function SamplePage() {
  return (
    <>
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="mx-auto flex max-w-page flex-col gap-10 px-4 pb-24 outline-none *:mx-auto *:w-full *:max-w-reading sm:px-8"
      >
        <PageHeader
          eyebrow="Solo en desarrollo"
          title="Muestra de componentes"
          lead="Recórrela con el teclado, a 320 px de ancho y con el movimiento reducido activado."
          className="-mx-4"
        />

        {/* La dirección del rediseño (T-616, solicitud 0): las piezas nuevas, antes de repartirse en las pantallas. */}
        <Section title="Dirección: la flor de la vida">
          <p className="text-body text-text-2">
            La geometría de la casa, en tres lugares y en ningún otro: la filigrana de una cabecera, la marca de un curso y los
            estados vacíos y de espera. Delante del nombre, en la barra, es el logotipo.
          </p>
          <div className="flex flex-wrap items-end gap-8">
            <Wordmark className="text-h3" />
            <Wordmark className="text-display-l" />
            <FlowerMark className="text-display-xl" />
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <span className="flex items-center gap-2 text-body-s text-text-2">
              <Rosette complete className="size-8" /> Curso terminado
            </span>
            <span className="flex items-center gap-2 text-body-s text-text-2">
              <Rosette complete={false} className="size-8" /> A medias
            </span>
            <SeedMark className="size-16" />
            <SeedMark waiting className="size-16" />
          </div>
          <div className="relative h-64 overflow-hidden rounded-lg glow-header surface-raised">
            <Filigree className="absolute -top-24 -right-20 size-112" />
          </div>
        </Section>

        <Section title="Dirección: cabeceras">
          <PageHeader eyebrow="Portal del maestro" title="Mis cursos" lead="Sin foto: la filigrana y el resplandor dan la textura." className="rounded-lg surface-raised" />
          <PageHeader photo={estrellas} eyebrow="El catálogo" title="Explorar" lead="Con foto de ambiente, para las pantallas del alumno." className="rounded-lg" />
        </Section>

        <Section title="Dirección: planos y tarjetas">
          <p className="text-body text-text-2">
            Tres planos: el fondo, las superficies con su borde de luz y su sombra, y lo que flota (la barra) sobre el fondo desenfocado.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 p-6 surface-raised">
              <p className="eyebrow text-accent-muted">Superficie elevada</p>
              <p className="font-display text-h3">El segundo plano</p>
              <p className="text-body-s text-text-2">Borde de luz arriba, contorno apenas visible y una sombra doble.</p>
            </div>
            {/* Lo que flota se ve sobre algo: aquí, sobre la foto, con el desenfoque de verdad. */}
            <div className="relative isolate overflow-hidden rounded-lg">
              <Image src={portada} alt="" fill sizes="360px" className="-z-10 object-cover" />
              <div className="m-6 flex flex-col gap-2 rounded-lg p-6 float-plane">
                <p className="eyebrow text-accent">Lo que flota</p>
                <p className="font-display text-h3">El tercer plano</p>
                <p className="text-body-s text-text-2">Translúcido, con el fondo desenfocado detrás.</p>
              </div>
            </div>
          </div>
          <ul className="grid grid-cols-2 gap-4">
            <li className="relative">
              <CourseCard href="#" {...SAMPLE_COURSE} progress={{ completed: 2, total: 6, lessonNumber: 3 }} />
            </li>
            <li className="relative">
              <CourseCard href="#" {...SAMPLE_COURSE} title="Meditación de la mañana" progress={{ completed: 6, total: 6, lessonNumber: 6 }} />
            </li>
          </ul>
        </Section>

        {/* La rejilla de portadas (T-616, solicitud 1): doce cursos de cuatro prácticas, a todo lo ancho, como en Explorar.
            Cada práctica tiene su tono y su motivo; dentro de una, el foco de luz y el recorte del motivo cambian por curso. */}
        <section aria-labelledby="muestra-portadas" className="flex flex-col gap-4 border-t border-border pt-8 max-w-none!">
          <h2 id="muestra-portadas" className="text-h2">
            Dirección: portadas
          </h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
            {SAMPLE_GRID.map((course) => (
              <li key={course.slug} className="relative min-w-0">
                <CourseCard
                  href={`#${course.slug}`}
                  title={course.title}
                  teacherName={course.teacher}
                  practice={course.practice}
                  levelName={course.level}
                  lessonCount={course.lessons}
                  isOpen={course.slug === "respirar-para-dormir"}
                  corner={course.slug === "meditacion-de-la-manana" || course.slug === "sonidos-del-cuenco" ? <span className="flex size-touch rounded-full float-plane" /> : undefined}
                />
              </li>
            ))}
          </ul>
        </section>

        <Section title="Dirección: estados">
          <FlowerState title="Estamos preparando los primeros cursos." className="surface-raised">
            Cuando se publiquen, aparecen aquí.
          </FlowerState>
          <FlowerState waiting title="Preparando tu video" className="surface-raised">
            Mux lo está procesando. Puedes seguir editando mientras tanto.
          </FlowerState>
        </Section>

        <Section title="Dirección: el botón principal">
          <p className="text-body text-text-2">
            Decidido en la tercera vuelta: el principal en oro con texto oscuro (11.44:1), para la acción principal de cada
            pantalla; el secundario en contorno. El relleno blanco se retira.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button>Continuar: lección 2</Button>
            <Button variant="secondary">Ver el curso</Button>
          </div>
        </Section>

        <Section title="Dirección: tipografía">
          <p className="eyebrow text-accent-muted">Antetítulo en versalitas</p>
          <p className="font-display text-display-xl">Una escuela de noche</p>
          <p className="font-display text-display-l">Títulos angostos y cerrados</p>
          <p className="text-stat tabular-nums">12 480</p>
        </Section>

        <Section title="Marca">
          <Wordmark className="text-display-xl" />
          <Wordmark className="text-h3" />
          <div className="relative isolate overflow-hidden rounded-md px-6 py-16">
            <Image src={portada} alt="" fill sizes="(min-width: 768px) 720px, 100vw" className="-z-20 object-cover" />
            {/* El velo del fondo (diseño, sección 3.12). Al 65 %, el nombre da 4.5 o más contra lo más claro de esta foto; cada lugar mide el suyo. */}
            <span className="absolute inset-0 -z-10 bg-bg/65" />
            <Wordmark className="text-display-l" />
          </div>
          <div className="flex items-center gap-4">
            {/* El icono del sitio, a tamaño de pestaña y de pantalla de inicio. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- el archivo tal cual, sin optimizar */}
            <img src="/icon.svg" alt="" width={32} height={32} />
            {/* eslint-disable-next-line @next/next/no-img-element -- el archivo tal cual, sin optimizar */}
            <img src="/apple-icon.png" alt="" width={96} height={96} className="rounded-md" />
          </div>
        </Section>

        <Section title="Tipografía">
          <p className="text-display-xl font-display">Display XL</p>
          <p className="text-display-l font-display">Display L</p>
          <p className="text-h1 font-display">Título 1</p>
          <p className="text-h2 font-display">Título 2</p>
          <p className="text-h3 font-display">Título 3</p>
          <p className="text-body-l">Cuerpo grande. Respirar es lo primero que hacemos y lo último.</p>
          <p className="text-body">Cuerpo. Respirar es lo primero que hacemos y lo último.</p>
          <p className="text-body-s text-text-2">Cuerpo chico, en el segundo tono de texto.</p>
          <p className="text-caption text-text-3">Nota, en el tono más tenue permitido.</p>
          <p className="text-label uppercase">Etiqueta</p>
          <p className="text-stat tabular-nums">1 250</p>
        </Section>

        <Section title="Superficies y color">
          <ul className="grid grid-cols-3 gap-3">
            {SWATCHES.map(([name, className]) => (
              <li key={name} className="flex flex-col gap-1">
                <span className={`${className} h-12 rounded-md border border-border`} />
                <span className="text-caption text-text-3">{name}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Botones">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Button>Crear cuenta</Button>
            <Button variant="secondary">Cancelar</Button>
            <Button variant="text">Olvidé mi contraseña</Button>
            <Button variant="danger">Cancelar suscripción</Button>
          </div>
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-start">
            <Button size="md">Mediano</Button>
            <Button href="/">Enlace con forma de botón</Button>
            <Button loading loadingLabel="Guardando…">
              Guardar cambios
            </Button>
            <Button disabled disabledReason="Espera 30 segundos para intentarlo otra vez.">
              Entrar
            </Button>
          </div>
        </Section>

        <Section title="Formulario">
          <form className="flex max-w-form flex-col gap-6">
            <FormErrorSummary
              errors={[
                { fieldId: "muestra-correo", message: "Escribe un correo con arroba, como ana@correo.com." },
                { fieldId: "muestra-clave", message: "A la contraseña le falta un número." },
              ]}
            />
            <TextField label="Nombre" name="name" autoComplete="name" hint="Así te verán los demás." />
            <TextField
              id="muestra-correo"
              label="Correo"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue="ana.correo.com"
              error="Escribe un correo con arroba, como ana@correo.com."
            />
            <TextField label="País" name="country" autoComplete="country-name" optional />
            <Textarea label="Nota de la revisión" name="note" hint="Qué revisaste y qué concluiste. Se queda escrita." />
            <Textarea label="Evidencia" name="evidence" error="Escribe la evidencia." />
            <Select
              label="Motivo"
              name="reason_code"
              prompt="Elige uno"
              options={[
                { value: "technical_error", label: "Error técnico" },
                { value: "test_account", label: "Cuenta de prueba" },
                { value: "other", label: "Otro" },
              ]}
            />
            <OTPField label="Código de tu aplicación" name="code" hint="Seis dígitos. Puedes pegarlo." />
            <PasswordField
              id="muestra-clave"
              label="Contraseña"
              name="password"
              autoComplete="new-password"
              rules={
                <ul className="flex list-disc flex-col gap-1 pl-5">
                  <li>8 caracteres o más</li>
                  <li>Las reglas reales las fija el TRD</li>
                </ul>
              }
              error="A la contraseña le falta un número."
            />
            <Disclaimer variant="signUp" />
            <Checkbox name="age" label="Tengo 18 años o más." />
            <ConsentCheckbox
              name="terms"
              invalid
              label={
                <>
                  Acepto los{" "}
                  <TextLink href="https://example.com" external>
                    términos y condiciones
                  </TextLink>
                  .
                </>
              }
            />
            <ConsentCheckbox
              variant="explained"
              name="history"
              title="Tu historial de cursos"
              description={
                <>
                  <p>Guardamos qué lecciones viste para que puedas seguir donde te quedaste.</p>
                  <p>Lo puedes borrar cuando quieras desde tu cuenta.</p>
                </>
              }
              label="Acepto que se guarde mi historial."
            />
            <Button type="submit">Crear cuenta</Button>
          </form>
        </Section>

        <Section title="Avisos">
          <InlineAlert tone="neutral">Te mandamos un correo para verificar tu cuenta.</InlineAlert>
          <InlineAlert tone="success">Guardado.</InlineAlert>
          <InlineAlert tone="warning" action={<Button variant="text">Reenviar el correo</Button>}>
            Todavía no verificas tu correo.
          </InlineAlert>
          <InlineAlert tone="danger">El correo o la contraseña no coinciden.</InlineAlert>
          <Disclaimer />
        </Section>

        <Section title="Carga e iconos">
          <div className="flex items-center gap-6">
            <Spinner size={16} />
            <Spinner size={24} />
            <Spinner size={40} label="Cargando tus cursos…" />
          </div>
          <p className="flex items-center gap-2 text-text-2">
            <Icon icon={Info} size={16} />
            <Icon icon={Info} size={20} />
            <Icon icon={Info} size={24} />
            Iconos de 16, 20 y 24 px, con trazo de 1.5.
          </p>
          <p>
            Un <TextLink href="/">enlace dentro de un texto</TextLink> va subrayado.
          </p>
        </Section>

        <Section title="Lección: regresar, pestañas y temario">
          <BackLink href="/inicio">Volver al inicio</BackLink>
          <Tabs
            label="Partes de la lección"
            idPrefix="muestra"
            items={[
              {
                id: "temario",
                label: "Temario",
                panel: (
                  <div className="flex flex-col gap-3">
                    <SampleFileUpload label="Elige el video" hint="MP4 o MOV, hasta 5 GB." accept=".mp4,.mov" />
                    <ProgressBar value={1} max={4} label="Avance del curso" text="1 de 4 lecciones" />
                    <div className="flex flex-col">
                      <LessonRow href="/muestra" number={1} title="Soltar los hombros" duration="5 min" state={COMPLETED} />
                      <LessonRow href="/muestra" number={2} title="Respirar acostado, con una pausa larga al final" duration="7 min" state={IN_PROGRESS} current />
                      <LessonRow href="/muestra" number={3} title="Alargar la salida" duration="6 min" state={IN_PROGRESS} />
                      <LessonRow href="/muestra" number={4} title="Dormir sin prisa" duration="8 min" />
                    </div>
                    <ProgressBar value={3} max={12} label="Avance del curso" text="3 de 12 lecciones" size="thin" />
                  </div>
                ),
              },
              { id: "sobre", label: "Sobre esta lección", panel: <p className="text-text-2">Un curso corto para volver a dormir.</p> },
            ]}
          />
        </Section>

        <Section title="Estado de pantalla completa">
          <div className="rounded-md border border-border">
            <FullScreenState
                    title="No encontramos esa página"
              primaryAction={<Button href="/">Ir al inicio</Button>}
              secondaryActions={
                <Button href="/" variant="secondary">
                  Explorar cursos
                </Button>
              }
              help={<TextLink href="/">Pedir ayuda</TextLink>}
              reference="Código de referencia: 4f2a91"
              focusTitle={false}
            >
              <p>Puede que la dirección esté mal o que ya no esté disponible.</p>
            </FullScreenState>
          </div>
        </Section>

        {/* El diálogo no va aquí: con JavaScript se abre como modal al montarse y taparía la muestra. Se revisa
            en el cierre de un periodo (PA-80) y en tests/ui/data-components.test.tsx. */}
        <Section title="Datos: estados, cifras y tablas">
          <div className="flex flex-wrap gap-4">
            <StatusBadge tone="neutral">Abierto</StatusBadge>
            <StatusBadge tone="active">En cierre</StatusBadge>
            <StatusBadge tone="attention">Acumulada</StatusBadge>
            <StatusBadge tone="good">Cerrado</StatusBadge>
            <StatusBadge tone="bad">Con error</StatusBadge>
          </div>
          {/* Dos columnas: la muestra es angosta, y a cuatro las cifras se enciman (T-616). */}
          <div className="grid gap-4 sm:grid-cols-2">
            <StatTile label="Bote" value="$12,000.00" context="Del cierre del 3 de noviembre de 2027." />
            <StatTile label="Cobrado en el periodo" value="$45,370.00" tag="Parcial, al 2 de noviembre de 2027" />
            <StatTile label="Bote sin consumo" value="$500.00" tone="attention" context="4.17 % del bote." />
            <StatTile label="Alumnos activos" value={null} />
          </div>
          <DataTable
            caption="El reparto (desplazable en el teléfono, con la primera columna fija)"
            scroll
            columns={[
              { key: "name", header: "Nombre" },
              { key: "assigned", header: "Reparto", numeric: true },
              { key: "unconsumed", header: "Sin consumo", numeric: true },
              { key: "total", header: "Total", numeric: true },
              { key: "remains", header: "Queda" },
            ]}
            rows={[
              { key: "a", cells: { name: "Ana Aguilar Benítez", assigned: "$11,500.00", unconsumed: "$500.00", total: "$12,000.00", remains: "Por pagar" } },
              { key: "b", cells: { name: "Beto Carrillo", assigned: "$80.00", unconsumed: "$0.00", total: "$80.00", remains: "Acumulada: debajo del pago mínimo" } },
            ]}
            totals={{ name: "Total", assigned: "$11,580.00", unconsumed: "$500.00", total: "$12,080.00", remains: "" }}
            empty="Nadie tuvo consumo que cuente."
          />
          <DataTable caption="Vacía" columns={[{ key: "a", header: "Periodo" }, { key: "b", header: "Estado" }]} rows={[]} empty="Todavía no hay periodos." />
        </Section>
      </main>
    </>
  );
}
