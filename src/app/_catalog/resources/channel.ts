// El campo que dice que hay JavaScript al pedir un recurso (T-404): solo existe cuando la pantalla ya se montó. Con él, la
// dirección vuelve en el estado y la abre el navegador; sin él, la acción redirige. No autoriza nada: quien lo mande a mano
// solo recibe su propia dirección de otra manera.

export const DOWNLOAD_CHANNEL_FIELD = "canal";
export const DOWNLOAD_CHANNEL_JS = "js";
