import { Check } from "lucide";

import { t } from "@/messages/format";
import { plans as text } from "@/messages/es/plans";
import { Icon } from "@/ui/icon";

// Lo que incluye cualquiera de los dos planes (T-616, solicitud 4): una sola lista, para `/planes` y, cuando llegue
// la sección de precios (4b), la portada; dos en la misma página llevan cada una su `id`. Solo lo que ya existe: sin constancias hasta T-504. Importa solo su
// bloque de textos: lo usa también la pantalla de los planes, que corre en el navegador.

// El de los maestros cita el término con su marcador, y es plantilla; los otros dos son texto.
const ITEMS = [text.includes.catalog, t(text.includes.teachers), text.includes.resources];

export function PlanIncludes({ id = "planes-incluye" }: { id?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p id={id} className="text-body-l text-text-2">
        {text.includesLead}
      </p>
      <ul aria-labelledby={id} className="flex flex-col gap-1 text-body text-text">
        {ITEMS.map((item) => (
          <li key={item} className="flex items-center gap-2">
            <Icon icon={Check} className="text-accent" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
