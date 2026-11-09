/** Si alguno de esos archivos pide la verificación entera (`scripts/ci-cambios.mjs`). */
export function touchesCode(files: readonly string[]): boolean;
/** Los archivos que cambian entre dos commits; un renombre, con sus dos nombres. */
export function changedFiles(base: string, head: string, cwd?: string): string[];
