// De qué dirección viene una petición, para el freno y los topes (TRD §9.9).
//
// Solo se lee la cabecera `x-real-ip`, que pone el alojamiento, y solo cuando hay un
// alojamiento de fiar delante. En local no lo hay y quien pide puede mandar la cabecera que
// quiera: ahí la dirección es desconocida. No se usa `x-forwarded-for`: su primera entrada
// es la que controla quien pide en cuanto haya otro intermediario.
//
// La clave que sale es la que el servicio pasa por la huella con secreto. La misma
// dirección tiene que dar siempre la misma clave, se escriba como se escriba; y todo lo que
// no sea una dirección escrita de la forma corriente es desconocido, no «casi válido». A lo
// desconocido el servicio le da un solo cubo compartido: nunca pase libre.

export type ClientIp =
  | {
      kind: "ip";
      /**
       * `v4:` y la dirección, o `v6:` y su prefijo de 64 bits. En IPv6 se agrupa por
       * prefijo porque una sola conexión doméstica tiene 2^64 direcciones a su disposición.
       */
      key: string;
    }
  | { kind: "unknown"; reason: "untrusted_proxy" | "absent" | "malformed" };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_CHARACTERS = /^[0-9a-fA-F:.]+$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/** La dirección como un número de 32 bits, o nulo si no está escrita en decimal corriente. */
function parseIpv4(text: string): number | null {
  const match = IPV4.exec(text);
  if (match === null) return null;
  let value = 0;
  for (const part of match.slice(1)) {
    // Un cero a la izquierda no se acepta: hay sistemas que lo leen en octal.
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const ipv4Key = (value: number) => `v4:${[24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".")}`;

/** Los ocho grupos de la dirección, o nulo. */
function parseIpv6(text: string): number[] | null {
  if (!IPV6_CHARACTERS.test(text)) return null;

  // Una IPv4 al final (`::ffff:203.0.113.7`) se reescribe como sus dos grupos.
  let rest = text;
  if (rest.includes(".")) {
    const lastColon = rest.lastIndexOf(":");
    const embedded = parseIpv4(rest.slice(lastColon + 1));
    if (lastColon === -1 || embedded === null) return null;
    rest = `${rest.slice(0, lastColon + 1)}${Math.floor(embedded / 0x10000).toString(16)}:${(embedded % 0x10000).toString(16)}`;
  }

  // Un salto (`::`) vale por los grupos de ceros que falten. Solo puede haber uno: un
  // segundo dejaría un grupo vacío después del primero, y un grupo vacío no pasa la
  // revisión de abajo.
  const gap = rest.indexOf("::");
  const headText = gap === -1 ? rest : rest.slice(0, gap);
  const tailText = gap === -1 ? "" : rest.slice(gap + 2);
  const head = headText === "" ? [] : headText.split(":");
  const tail = tailText === "" ? [] : tailText.split(":");
  if (![...head, ...tail].every((group) => HEX_GROUP.test(group))) return null;

  const missing = 8 - head.length - tail.length;
  if (gap === -1 ? missing !== 0 : missing < 1) return null;
  const hex = (group: string) => Number.parseInt(group, 16);
  return [...head.map(hex), ...new Array<number>(missing).fill(0), ...tail.map(hex)];
}

export function resolveClientIp(
  realIp: string | null | undefined,
  options: { /** Hay un alojamiento delante que pone la cabecera y pisa la que mande quien pide. */ proxyTrusted: boolean },
): ClientIp {
  if (!options.proxyTrusted) return { kind: "unknown", reason: "untrusted_proxy" };
  if (realIp === null || realIp === undefined || realIp === "") return { kind: "unknown", reason: "absent" };

  const v4 = parseIpv4(realIp);
  if (v4 !== null) return { kind: "ip", key: ipv4Key(v4) };

  const groups = parseIpv6(realIp);
  if (groups === null) return { kind: "unknown", reason: "malformed" };

  // Una IPv4 escrita dentro de una IPv6 (`::ffff:a.b.c.d`) es esa IPv4: misma clave.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { kind: "ip", key: ipv4Key(groups.slice(6).reduce((value, group) => value * 0x10000 + group, 0)) };
  }
  return {
    kind: "ip",
    key: `v6:${groups
      .slice(0, 4)
      .map((group) => group.toString(16))
      .join(":")}::/64`,
  };
}
