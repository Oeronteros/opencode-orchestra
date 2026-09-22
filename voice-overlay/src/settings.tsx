import { useEffect, useRef, useState } from "react";
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
    return normalizeOverlaySettings(JSON.parse(raw ?? "null"));
  } catch {
    return normalizeOverlaySettings(null);
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
  const refresh = useRef(props.onRefreshSessions);
  refresh.current = props.onRefreshSessions;
  useEffect(() => {
    if (draft.target !== "web") return;
    const timer = window.setTimeout(() => refresh.current(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft.host, draft.port, draft.username, draft.password, draft.target]);
  const set = (patch: Partial<OverlaySettings>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const selectedSessionMissing =
    draft.sessionId !== "" &&
    !props.sessions.some((session) => session.id === draft.sessionId);
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
        <fieldset>
          <legend>После распознавания</legend>
          {draft.target === "auto" && <p className="field-note">В открытую вкладку текст только вставляется. Отправку вы нажимаете в OpenCode.</p>}
          <label>
            <input
              type="radio"
              name="action"
              disabled={draft.target === "auto"}
              checked={draft.target === "auto" || draft.postTranscriptionAction === "insert"}
              onChange={() => set({ postTranscriptionAction: "insert" })}
            />
            {draft.target !== "web" ? "Вставить текст" : "Проверить текст перед отправкой"}
          </label>
          <label>
            <input
              type="radio"
              name="action"
              disabled={draft.target === "auto"}
              checked={draft.target !== "auto" && draft.postTranscriptionAction === "insert-and-submit"}
              onChange={() =>
                set({ postTranscriptionAction: "insert-and-submit" })
              }
            />
            {draft.target === "tui" ? "Вставить и отправить" : "Сразу отправить в сессию"}
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
            Порт вкладки (voice-web)
            <input type="number" min="1" max="65535" value={draft.browserPort}
              onChange={(e) => set({ browserPort: Number(e.target.value) || 4097 })} />
            <small className="field-note">Откройте OpenCode через opencode-orchestra voice-web, обычно на http://127.0.0.1:4097.</small>
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
                onChange={() => set({ target: "auto", postTranscriptionAction: "insert" })}
              />
              Открытая вкладка браузера
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
                {selectedSessionMissing && (
                  <option value={draft.sessionId}>
                    Недоступна — {draft.sessionId}
                  </option>
                )}
                {props.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}{s.directory ? ` — ${s.directory}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => props.onRefreshSessions(draft)}
              >
                Обновить сессии
              </button>
              {selectedSessionMissing && (
                <small className="field-note" role="alert">
                  Сервер больше не возвращает выбранную сессию.
                </small>
              )}
              {props.sessionError && (
                <small className="field-note" role="alert">
                  {props.sessionError}
                </small>
              )}
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
