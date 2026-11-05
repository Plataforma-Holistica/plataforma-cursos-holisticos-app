// Los tipos de importar una imagen (`import foto from "@/ui/photos/portada-muelle.jpg"`, T-614). Los trae
// también `next-env.d.ts`, pero ese archivo lo genera Next al compilar o al levantar el desarrollo, y git lo
// ignora: en la integración continua los tipos se revisan antes de compilar, y sin esto no existirían.
/// <reference types="next/image-types/global" />
