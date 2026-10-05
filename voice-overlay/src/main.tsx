import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { VoiceWidget } from "./VoiceWidget";
import "./styles.css";

const widget = isTauri() && getCurrentWindow().label === "voice-widget";
if (widget) document.documentElement.classList.add("voice-widget-document");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {widget ? <VoiceWidget /> : <App />}
  </StrictMode>,
);
