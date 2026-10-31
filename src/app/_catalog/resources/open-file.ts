// Abrir un archivo, o volver a pedir la página: en su propio archivo, porque un DOM simulado no navega.

/** Cuánto vive el marco oculto: lo que tarda en empezar la descarga, que después sigue sola. */
const FRAME_LIFE_MS = 60_000;

/**
 * Abre la dirección de un adjunto en la página, que se queda donde está. Es el camino del alumno: ahí no hay nada escrito que
 * perder, y si la respuesta no fuera un adjunto (Storage cayó justo después de firmar) la página se iría a ese error. Límite
 * conocido, porque un marco oculto no está medido en un iPhone, y ahí dejaría sin descarga a todos (decisión mía sin confirmar).
 */
export function openFile(url: string): void {
  window.location.assign(url);
}

/**
 * Abre la dirección de un adjunto en un marco oculto: la página no navega, ni dispara el aviso de salir. Es para el editor, donde
 * puede haber algo sin guardar. Un adjunto no dispara `load`; si se dispara, lo que llegó fue otra cosa (en Chrome, medido; otro
 * navegador podría avisar de más, y por eso el mensaje dice «si no empezó»).
 */
export function openFileInFrame(url: string, onNotAFile: () => void): void {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  const timer = window.setTimeout(() => frame.remove(), FRAME_LIFE_MS);
  frame.addEventListener("load", () => {
    window.clearTimeout(timer);
    frame.remove();
    onNotAFile();
  });
  frame.src = url;
  document.body.append(frame);
}

export function reloadPage(): void {
  window.location.reload();
}
