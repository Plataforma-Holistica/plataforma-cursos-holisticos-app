import { Info, SearchX } from "lucide";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { Disclaimer } from "@/ui/disclaimer";
import { FormErrorSummary } from "@/ui/form-error-summary";
import { FullScreenState } from "@/ui/full-screen-state";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { PasswordField } from "@/ui/password-field";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { Spinner } from "@/ui/spinner";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";

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

export default function SamplePage() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-10 px-4 py-16 outline-none">
      <header className="flex flex-col gap-3">
        <p className="text-label text-text-3 uppercase">Solo en desarrollo</p>
        <h1 className="text-display-l">Muestra de componentes</h1>
        <p className="text-body-l text-text-2">
          Recórrela con el teclado, a 320 px de ancho y con el movimiento reducido activado.
        </p>
      </header>

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

      <Section title="Estado de pantalla completa">
        <div className="rounded-md border border-border">
          <FullScreenState
            icon={SearchX}
            title="No encontramos esa página"
            primaryAction={<Button href="/">Ir al inicio</Button>}
            secondaryActions={
              <Button href="/" variant="secondary">
                Explorar cursos
              </Button>
            }
            help={<TextLink href="/">Pedir ayuda</TextLink>}
            reference="Código de referencia: 4f2a91"
          >
            <p>Puede que la dirección esté mal o que ya no esté disponible.</p>
          </FullScreenState>
        </div>
      </Section>
    </main>
  );
}
