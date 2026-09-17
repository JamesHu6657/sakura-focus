import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/pomodoro/AppShell";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
