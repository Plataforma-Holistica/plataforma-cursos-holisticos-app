import { messages } from "@/messages/es";

export default function HomePage() {
  return (
    <main>
      <h1>{messages.app.name}</h1>
      <p>{messages.home.status}</p>
    </main>
  );
}
