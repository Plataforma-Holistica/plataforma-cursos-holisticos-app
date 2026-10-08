import { messages, t } from "@/messages";

export default function HomePage() {
  return (
    <main id="contenido" tabIndex={-1} className="mx-auto max-w-form px-4 py-16 outline-none">
      <h1 className="text-h1">{t(messages.meta.titleDefault)}</h1>
      <p className="mt-4 text-text-2">{messages.states.home.status}</p>
    </main>
  );
}
