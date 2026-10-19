import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import type { Device } from "@/services/account/account";

// De qué navegador y sistema dijo ser una sesión, como se le dice a una persona («Chrome en
// Windows»). Lo usan la lista de sesiones de la cuenta (PA-25) y la lista de reproducciones en
// otro lugar (PA-34, T-204): la misma persona reconoce el mismo nombre en las dos.

const text = account.manage;

export function deviceName(device: Device): string {
  const browser = device.browser === null ? text.unknownBrowser : text.browsers[device.browser];
  return device.system === null ? browser : t(text.deviceOn, { browser, system: text.systems[device.system] });
}
