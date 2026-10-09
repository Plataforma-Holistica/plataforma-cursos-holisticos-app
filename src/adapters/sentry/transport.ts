import type { makeNodeTransport } from "@sentry/nextjs";

// El paquete no exporta estos dos tipos con nombre: salen de uno de sus transportes.
type Transport = ReturnType<typeof makeNodeTransport>;
type Envelope = Parameters<Transport["send"]>[0];

// La última puerta antes de la red. Todo lo que el SDK manda sale en sobres, y cada cosa
// dentro de un sobre dice de qué tipo es. Solo un tipo pasa por el filtro (`scrub.ts`):
// los errores. Lo demás (una traza, un aviso de trabajo programado, un comentario de una
// persona con su correo, un archivo adjunto, el conteo de visitas) sale por otro camino.
//
// Las opciones ya apagan cada una de esas cosas (`options.ts`) y el lint impide llamar al
// SDK desde fuera del adaptador. Esto es lo que queda si las dos fallan: lo que no es un
// error se descarta aquí, lo haya pedido quien lo haya pedido.

const ERROR = "event";

/** Envuelve un transporte del SDK para que solo mande errores. */
export function onlyErrors<Options>(
  make: (options: Options) => Transport,
): (options: Options) => Transport {
  return (options) => {
    const transport = make(options);
    return {
      flush: (timeout) => transport.flush(timeout),
      send(envelope) {
        const [headers, items] = envelope;
        const errors = items.filter(([item]) => item.type === ERROR);
        if (errors.length === 0) return Promise.resolve({});
        return transport.send([headers, errors] as Envelope);
      },
    };
  };
}
