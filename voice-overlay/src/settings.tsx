import { useState } from "react";
import type { ServerConfig, SessionRef } from "./lib/opencode";
import {
  normalizeOverlaySettings,
  type VoicePreferences,
} from "../../src/voice-context";
import { WindowHeader } from "./WindowHeader";

export interface OverlaySettings extends ServerConfig, VoicePreferences { browserPort: number }

const KEY = "voice-overlay-settings:v1";

export function loadSettings(): OverlaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...normalizeOverlaySettings(JSON.parse(raw ?? "null")), target: "tui", postTranscriptionAction: "insert" };
  } catch {
    return { ...normalizeOverlaySettings(null), target: "tui", postTranscriptionAction: "insert" };
  }
}

export function SettingsView(props: {
  settings: OverlaySettings;
  devices: string[];
  sessions: SessionRef[];
  deviceError: string | null;
  sessionError: string | null;
  onRefreshDevices: () => void;
  onRefreshSessions: (settings: OverlaySettings) => void;
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
          <button type="button" onClick={props.onRefreshDevices}>
            Обновить микрофоны
          </button>
          {props.deviceError && (
            <small className="field-note" role="alert">
              {props.deviceError}
            </small>
          )}
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
        <p className="field-note">Текст добавляется в промпт TUI. Отправку вы нажимаете в OpenCode.</p>
        <details>
          <summary>Дополнительно</summary>
          <p className="settings-subtitle">
            Подключение к TUI OpenCode
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
        </details>
        {error && <p role="alert">{error}</p>}
        <div className="settings-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              try {
                const next = { ...draft, target: "tui" as const, postTranscriptionAction: "insert" as const };
                localStorage.setItem(KEY, JSON.stringify(next));
                props.onChange(next);
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
