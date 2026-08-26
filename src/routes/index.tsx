import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/pomodoro/AppShell";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <AppShell />;
}
