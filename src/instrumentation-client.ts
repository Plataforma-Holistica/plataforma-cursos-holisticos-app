import { startErrorReporting } from "@/services/error-reporting/browser";

// Next corre este archivo en el navegador antes de que la página cobre vida. Lo único que
// hace es encender el registro de errores (RNF-16).
startErrorReporting();
