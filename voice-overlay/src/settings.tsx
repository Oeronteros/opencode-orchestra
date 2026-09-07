import { useState } from "react";
import type { ServerConfig, SessionRef, Target } from "./lib/opencode";

export interface OverlaySettings extends ServerConfig {
  device: string;
  model: string;
  target: Target;
  sessionId: string;
}

const DEFAULTS: OverlaySettings = {
  host: "127.0.0.1",
  port: 4096,
  username: "",
  password: "",
  device: "",
  model: "base",
  target: "tui",
  sessionId: "",
};

const KEY = "voice-overlay-settings:v1";

export function loadSettings(): OverlaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<OverlaySettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function SettingsView(props: {
  settings: OverlaySettings;
  devices: string[];
  sessions: SessionRef[];
  onChange: (next: OverlaySettings) => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<OverlaySettings>(props.settings);
  const set = (patch: Partial<OverlaySettings>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <main>
      <h1>Настройки</h1>
      <label>
        Хост
        <input value={draft.host} onChange={(e) => set({ host: e.target.value })} />
      </label>
      <label>
        Порт
        <input
          type="number"
          value={draft.port}
          onChange={(e) => set({ port: Number(e.target.value) || 4096 })}
        />
      </label>
      <label>
        Пользователь
        <input value={draft.username} onChange={(e) => set({ username: e.target.value })} />
      </label>
      <label>
        Пароль
        <input
          type="password"
          value={draft.password}
          onChange={(e) => set({ password: e.target.value })}
        />
      </label>
      <label>
        Микрофон
        <select value={draft.device} onChange={(e) => set({ device: e.target.value })}>
          <option value="">По умолчанию</option>
          {props.devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label>
        Модель
        <select value={draft.model} onChange={(e) => set({ model: e.target.value })}>
          <option value="base">base — быстрее (~140 МБ)</option>
          <option value="small">small — точнее (~460 МБ)</option>
        </select>
      </label>
      <fieldset>
        <legend>Куда вставлять</legend>
        <label>
          <input
            type="radio"
            name="target"
            value="tui"
            checked={draft.target === "tui"}
            onChange={() => set({ target: "tui" })}
          />
          TUI-промпт
        </label>
        <label>
          <input
            type="radio"
            name="target"
            value="web"
            checked={draft.target === "web"}
            onChange={() => set({ target: "web" })}
          />
          Web-сессия
        </label>
      </fieldset>
      <label>
        Сессия
        <select
          value={draft.sessionId}
          disabled={draft.target === "tui"}
          onChange={(e) => set({ sessionId: e.target.value })}
        >
          <option value="">Выбери сессию</option>
          {props.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(KEY, JSON.stringify(draft));
          props.onChange(draft);
        }}
      >
        Сохранить
      </button>
      <button type="button" onClick={props.onBack}>
        Назад
      </button>
    </main>
  );
}
