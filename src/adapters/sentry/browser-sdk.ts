// Lo único del SDK que el navegador usa. `browser.ts` pide este archivo con `import()`,
// y no el paquete entero: pedir el paquete se llevaría también la grabación de sesiones,
// las trazas y todo lo demás que no se usa: casi el triple de peso.
export { breadcrumbsIntegration, captureException, init, makeFetchTransport } from "@sentry/nextjs";
