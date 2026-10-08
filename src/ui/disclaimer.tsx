import { Info } from "lucide";

import { ui } from "@/messages/es/ui";
import { t } from "@/messages/format";

import { cx } from "./cx";
import { Icon } from "./icon";

// Deslinde (diseño, sección 5.5; RF-809): la Plataforma es educativa y no sustituye la
// atención profesional. Una línea con su icono. En el registro va más grande, antes de las
// casillas.

const VARIANTS = {
  line: "text-caption text-text-3",
  signUp: "text-body-s text-text-2",
} as const;

export function Disclaimer({ variant = "line" }: { variant?: keyof typeof VARIANTS }) {
  return (
    <p className={cx("flex items-start gap-2", VARIANTS[variant])}>
      <Icon icon={Info} size={16} className="mt-0.5" />
      <span>{t(ui.disclaimer)}</span>
    </p>
  );
}
