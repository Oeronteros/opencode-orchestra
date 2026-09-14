import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowHeader({ busy = false }: { busy?: boolean }) {
  return (
    <header className="window-header">
      <div className="window-brand" onPointerDown={(event) => {
        if (event.button === 0) void getCurrentWindow().startDragging().catch(() => undefined);
      }}>
        <span className="brand-mark" aria-hidden="true">◈</span>
        <span>orchestra <span className="brand-divider">/</span> voice</span>
      </div>
      <button className="icon-button close-button" aria-label="Закрыть окно" title="Закрыть окно"
        disabled={busy} onClick={() => void getCurrentWindow().close().catch(() => undefined)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
      </button>
    </header>
  );
}
