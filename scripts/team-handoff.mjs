// Imprime un código para dictar y su huella, para la emergencia: restablecerle el segundo
// factor a alguien del equipo cuando nadie con configuración puede hacerlo desde la pantalla
// (quien podía perdió también su factor, o a la persona le cambiaron el correo).
//
//   pnpm team:handoff
//
// No toca ninguna base ni la red. Quien opera la base pega la HUELLA en la sentencia de
// `private.system_reset_second_factor()` (manual de operación), y le DICTA el código a la
// persona por teléfono o en persona. El código no se escribe en ninguna sentencia, no se
// manda por correo y no se guarda: si se pierde, se corre esto otra vez y se restablece de
// nuevo.
//
// La forma del código y cómo se le saca la huella son las de la aplicación
// (`dictatedCode` y `handoffPrint`, en src/services/account/). Una prueba corre este guion y
// compara: si allá cambian, esta deja de pasar.

import { createHash, randomInt } from "node:crypto";

// Sin 0, 1, I, L ni O: se dicta por voz, y esas se confunden.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LENGTH = 16;

let code = "";
for (let index = 0; index < LENGTH; index += 1) {
  if (index > 0 && index % 4 === 0) code += "-";
  code += ALPHABET.charAt(randomInt(ALPHABET.length));
}
// La huella es la del código sin espacios ni guiones y en mayúsculas: quien lo teclea puede
// ponerlos o no.
const print = createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");

console.log(`Código para dictar: ${code}`);
console.log(`Huella para la sentencia: ${print}`);
console.log("El código se dicta por teléfono o en persona. No lo pegues en ninguna sentencia ni lo mandes por correo.");
