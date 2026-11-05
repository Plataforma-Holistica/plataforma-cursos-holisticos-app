"use client";

import { FileUpload, type FileUploadProps } from "@/ui/file-upload";

// La subida de archivo de la muestra, sin nada que hacer con lo elegido. Va en el navegador porque
// la página es del servidor, y una función no viaja como propiedad a un componente del navegador.
export function SampleFileUpload(props: Omit<FileUploadProps, "onFile">) {
  return <FileUpload {...props} onFile={() => undefined} />;
}
