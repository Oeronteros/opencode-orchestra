import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { EMPTY_WIDGET, widgetCopy, type WidgetSnapshot } from "./lib/widget";

/** Only the main App owns the recorder. This window mirrors it and sends clicks. */
export function VoiceWidget() {
  const [state, setState] = useState(EMPTY_WIDGET);
  const [failure, setFailure] = useState<string | null>(null);
  const [clicking, setClicking] = useState(false);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    let received = false;
    void listen<WidgetSnapshot>("voice-widget-state", event => {
      received = true;
      if (!disposed) { setState(event.payload); setFailure(null); }
    }).then(async unlisten => {
      if (disposed) { unlisten(); return; }
      cleanup = unlisten;
      const initial = await invoke<WidgetSnapshot>("voice_widget_snapshot");
      if (!disposed && !received) setState(initial);
    }).catch(e => { if (!disposed) setFailure(String(e)); });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  const copy = widgetCopy(state);
  const toggle = async () => {
    if (clicking || state.blocked) return;
    setClicking(true);
    setFailure(null);
    try { await invoke("toggle_voice_widget"); }
    catch (e) { setFailure(String(e)); }
    finally { setClicking(false); }
  };
  return <main className="voice-widget-shell" data-status={state.status}>
    <button type="button" className="voice-widget-button" onClick={() => void toggle()}
      disabled={!state.enabled || state.blocked || clicking} aria-label={copy.action}
      title={failure ?? state.message ?? `${copy.action} · Ctrl+Alt+Space`}>
      <span className="voice-widget-icon" aria-hidden="true">
        {state.status === "transcribing" || state.status === "starting"
          ? <span className="spinner" />
          : state.status === "recording" ? <span className="stop-icon" />
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <rect x="8" y="2" width="8" height="13" rx="4" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" />
            </svg>}
      </span>
      <span className="voice-widget-copy" role="status" aria-live="polite">
        <strong>{failure ? "Не удалось" : copy.label}</strong>
        <small>{failure ? "Выберите исходное окно" : copy.hint}</small>
      </span>
      {state.status === "recording" && <span className="voice-widget-dot" aria-hidden="true" />}
    </button>
  </main>;
}
