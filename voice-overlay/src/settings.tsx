import { useState } from "react";
import type { ServerConfig, SessionRef } from "./lib/opencode";
import {
  normalizeOverlaySettings,
  type VoicePreferences,
} from "../../src/voice-context";
import { WindowHeader } from "./WindowHeader";

export interface OverlaySettings extends ServerConfig, VoicePreferences {}

const KEY = "voice-overlay-settings:v1";

export function loadSettings(): OverlaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeOverlaySettings(JSON.parse(raw ?? "null"));
  } catch {
    return normalizeOverlaySettings(null);
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
  const [error, setError] = useState("");
  const set = (patch: Partial<OverlaySettings>) =>
    setDraft((d) => ({ ...d, ...patch }));
  return (
    <main className="overlay-shell settings-shell">
      <WindowHeader />
      <div className="settings-content">
        <h1>Голос</h1>
        <p className="settings-subtitle">Локальное распознавание речи</p>
        <label>
          Микрофон
          <select
            value={draft.device}
            onChange={(e) => set({ device: e.target.value })}
          >
            <option value="">
              {props.devices[0]
                ? `По умолчанию — ${props.devices[0]}`
                : "Системный по умолчанию"}
            </option>
            {props.devices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          Модель
          <select
            value={draft.model}
            onChange={(e) =>
              set({ model: e.target.value as VoicePreferences["model"] })
            }
          >
            <option value="base">base — быстрая (~140 МБ)</option>
            <option value="small">small — точнее (~460 МБ)</option>
          </select>
        </label>
        <fieldset>
          <legend>После распознавания</legend>
          <label>
            <input
              type="radio"
              name="action"
              checked={draft.postTranscriptionAction === "insert"}
              onChange={() => set({ postTranscriptionAction: "insert" })}
            />
            Вставить текст
          </label>
          <label>
            <input
              type="radio"
              name="action"
              checked={draft.postTranscriptionAction === "insert-and-submit"}
              onChange={() =>
                set({ postTranscriptionAction: "insert-and-submit" })
              }
            />
            Вставить и отправить
          </label>
        </fieldset>
        <details>
          <summary>Дополнительно</summary>
          <p className="settings-subtitle">
            Подключение к OpenCode и ручное назначение
          </p>
          <label>
            Хост
            <input
              value={draft.host}
              onChange={(e) => set({ host: e.target.value })}
            />
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
            <input
              value={draft.username}
              onChange={(e) => set({ username: e.target.value })}
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={draft.password}
              onChange={(e) => set({ password: e.target.value })}
            />
          </label>
          <fieldset>
            <legend>Куда вставлять</legend>
            <label>
              <input
                type="radio"
                name="target"
                checked={draft.target === "auto"}
                onChange={() => set({ target: "auto" })}
              />
              Автоматически
            </label>
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
          {draft.target === "web" && (
            <label>
              Сессия
              <select
                value={draft.sessionId}
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
          )}
        </details>
        {error && <p role="alert">{error}</p>}
        <div className="settings-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              try {
                localStorage.setItem(KEY, JSON.stringify(draft));
                props.onChange(draft);
              } catch {
                setError(
                  "Не удалось сохранить настройки. Проверьте доступ к хранилищу.",
                );
              }
            }}
          >
            Сохранить
          </button>
          <button type="button" onClick={props.onBack}>
            Назад
          </button>
        </div>
      </div>
    </main>
  );
}
