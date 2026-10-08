import { messages, t } from "@/messages";

export default function HomePage() {
  return (
    <main>
      <h1>{t(messages.meta.titleDefault)}</h1>
      <p>{messages.states.home.status}</p>
    </main>
  );
}
