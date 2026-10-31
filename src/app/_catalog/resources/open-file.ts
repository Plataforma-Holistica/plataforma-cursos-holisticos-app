// Salir del navegador hacia un archivo, o volver a pedir la página: en su propio archivo, porque un DOM simulado no navega.

/** Abre la dirección de un adjunto. La página no se va: el navegador la baja y se queda donde está. */
export function openFile(url: string): void {
  window.location.assign(url);
}

export function reloadPage(): void {
  window.location.reload();
}
