import { useEffect, useRef, useState } from "react";
import {
  appendToPrompt,
  submitPrompt,
  cancelTranscription,
  listMicrophones,
  listSessions,
  sendToSession,
  startRecording,
  stopRecording,
  transcribe,
  type OverlayStatus,
} from "./api";
import { errorCopy, type OverlayErrorCode } from "./lib/errors";
import { MAX_SECONDS } from "./lib/audio";
import type { SessionRef } from "./lib/opencode";
import { loadSettings, SettingsView, type OverlaySettings } from "./settings";
import { WindowHeader } from "./WindowHeader";
import { createVoicePolicy } from "../../src/voice-context";

function codeOf(message: string): OverlayErrorCode | null {
  const head = message.split(": ")[0];
  const codes: OverlayErrorCode[] = [
    "no-mic",
    "no-ffmpeg",
    "no-audio-server",
    "model-missing",
    "server-unreachable",
    "unauthorized",
    "empty-transcript",
    "empty-recording",
    "too-long",
    "transcribe-failed",
    "no-session",
    "session-not-found",
  ];
  return (codes as string[]).includes(head ?? "")
    ? (head as OverlayErrorCode)
    : null;
}

export function App() {
  const [settings, setSettings] = useState<OverlaySettings>(loadSettings);
  const [devices, setDevices] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [sessionListError, setSessionListError] = useState<string | null>(null);
  const [status, setStatus] = useState<OverlayStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const operation = useRef(false);
  const timer = useRef<number | null>(null);
  const invocation = useRef<OverlaySettings>(settings);
  const sessionRequest = useRef(0);
  const destination = createVoicePolicy().resolve(
    settings.target,
    { source: "tui" },
    settings.sessionId,
  );
  const manual =
    destination.type === "session" || destination.type === "picker";

  useEffect(() => {
    if (status !== "recording") return;
    const started = Date.now();
    setElapsed(0);
    const interval = window.setInterval(
      () =>
        setElapsed(
          Math.min(MAX_SECONDS, Math.floor((Date.now() - started) / 1000)),
        ),
      250,
    );
    return () => window.clearInterval(interval);
  }, [status]);

  const loadSessions = async (cfg: OverlaySettings) => {
    const request = ++sessionRequest.current;
    try {
      setSessionListError(null);
      const result = await listSessions(cfg);
      if (request === sessionRequest.current) setSessions(result);
    } catch (e) {
      if (request === sessionRequest.current) {
        setSessions([]);
        setSessionListError(String(e));
      }
    }
  };

  const loadMicrophones = async () => {
    try {
      setDeviceError(null);
      setDevices(await listMicrophones());
    } catch (e) {
      setDeviceError(String(e));
    }
  };

  useEffect(() => {
    void loadMicrophones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSessions([]);
    if (settings.target !== "web" || showSettings) return;
    const refresh = () => { void loadSessions(settings); };
    refresh();
    const interval = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      ++sessionRequest.current;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [settings.host, settings.port, settings.username, settings.password, settings.target, showSettings]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const fail = (message: string) => {
    const code = codeOf(message);
    setError(code !== null ? errorCopy(code) : message);
    setErrorDetail(
      code !== null ? message.slice(message.indexOf(":") + 1).trim() : null,
    );
    setStatus("error");
  };

  const onRecord = async () => {
    if (operation.current) return;
    operation.current = true;
    setStarting(true);
    setError(null);
    setErrorDetail(null);
    setNotice(null);
    invocation.current = { ...settings };
    try {
      await startRecording(
        settings.device === "" ? undefined : settings.device,
        settings.model,
      );
    } catch (e) {
      fail(String(e));
      return;
    } finally {
      operation.current = false;
      setStarting(false);
    }
    setStatus("recording");
    timer.current = window.setTimeout(() => {
      void onStop(true);
    }, MAX_SECONDS * 1000);
  };

  const onStop = async (auto = false) => {
    if (operation.current) return;
    operation.current = true;
    const settings = invocation.current;
    const destination = createVoicePolicy().resolve(
      settings.target,
      { source: "tui" },
      settings.sessionId,
    );
    try {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      setStatus("transcribing");
      let wav: string;
      try {
        wav = await stopRecording();
      } catch (e) {
        fail(String(e));
        return;
      }
      let text: string;
      try {
        setRecognizing(true);
        text = await transcribe(wav, settings.model);
      } catch (e) {
        if (String(e).startsWith("cancelled:")) {
          setNotice("Распознавание отменено. Предыдущий текст сохранён.");
          setStatus("idle");
          return;
        }
        fail(String(e));
        return;
      } finally {
        setRecognizing(false);
        setCancelling(false);
      }
      setPreview((previous) =>
        settings.target === "web" && previous ? `${previous}\n${text}` : text,
      );
      if (settings.target === "web") {
        if (
          settings.postTranscriptionAction === "insert-and-submit" &&
          destination.type === "session"
        ) {
          try {
            await sendToSession(settings, destination.sessionId, text);
            // Only this recording was submitted; retain any older unsent draft.
            setPreview(preview);
            setNotice("Отправлено в выбранную сессию");
            setStatus("idle");
          } catch (e) {
            fail(String(e));
          }
          return;
        }
        setNotice(
          auto
            ? "Достигнут лимит 120 секунд — нажми «Отправить в сессию»"
            : "Проверь текст и нажми «Отправить в сессию»",
        );
        setStatus("idle");
        return;
      }
      try {
        await appendToPrompt(settings, text);
        if (settings.postTranscriptionAction === "insert-and-submit") {
          // A failed submit must not trigger a second append or lose the draft.
          try {
            await submitPrompt(settings);
          } catch (e) {
            setNotice(
              `Текст вставлен; отправьте его из TUI вручную. ${String(e)}`,
            );
            setStatus("idle");
            return;
          }
        }
        setNotice(
          (auto ? "Достигнут лимит 120 секунд. " : "") +
            "Передано серверу. Проверь текст в TUI; если он не появился — скопируй его ниже.",
        );
        setStatus("idle");
      } catch (e) {
        const message = String(e);
        if (
          message.startsWith("fallback:") ||
          message.startsWith("server-unreachable:")
        ) {
          try {
            await navigator.clipboard.writeText(text);
            setNotice("Сервер недоступен — текст скопирован в буфер обмена");
          } catch {
            setNotice("Сервер недоступен — скопируй текст вручную");
          }
          setStatus("idle");
          return;
        }
        fail(message);
      }
    } finally {
      operation.current = false;
    }
  };

  const onSend = async () => {
    if (
      operation.current ||
      !preview.trim() ||
      (settings.target === "web" && settings.sessionId === "")
    )
      return;
    operation.current = true;
    setSending(true);
    setError(null);
    try {
      if (settings.target === "web") {
        await sendToSession(settings, settings.sessionId, preview);
        setNotice("Отправлено в сессию");
        setPreview("");
      } else {
        await appendToPrompt(settings, preview);
        setNotice("Передано серверу. Проверь текст в TUI перед отправкой.");
      }
      setStatus("idle");
    } catch (e) {
      const message = String(e);
      if (
        message.startsWith("fallback:") ||
        message.startsWith("server-unreachable:")
      ) {
        try {
          await navigator.clipboard.writeText(preview);
          setNotice("Сервер недоступен — текст скопирован в буфер обмена");
        } catch {
          setNotice("Сервер недоступен — скопируй текст вручную");
        }
        setStatus("idle");
        return;
      }
      fail(message);
    } finally {
      operation.current = false;
      setSending(false);
    }
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(preview);
      setNotice("Текст скопирован");
    } catch {
      setNotice(
        "Не удалось открыть буфер обмена. Выдели и скопируй текст вручную.",
      );
    }
  };

  const onCancel = async () => {
    setCancelling(true);
    try {
      await cancelTranscription();
    } catch (e) {
      setNotice(String(e));
      setCancelling(false);
    }
  };

  if (showSettings) {
    return (
      <SettingsView
        settings={settings}
        devices={devices}
        sessions={sessions}
        deviceError={deviceError}
        sessionError={sessionListError}
        onRefreshDevices={() => void loadMicrophones()}
        onRefreshSessions={(next) => void loadSessions(next)}
        onChange={(next) => {
          setSettings(next);
          setError(null);
          setStatus("idle");
          setShowSettings(false);
        }}
        onBack={() => setShowSettings(false)}
      />
    );
  }

  const busy =
    starting || sending || status === "recording" || status === "transcribing";
  const canSend = preview.trim() !== "" && !busy;
  const selectedSessionMissing =
    settings.sessionId !== "" &&
    !sessions.some((session) => session.id === settings.sessionId);
  return (
    <main className="overlay-shell" data-status={status}>
      <WindowHeader busy={busy} />
      <div className="toolbar">
        <span className="target-tag">
          {settings.target === "web" ? "Web-сессия" : "Промпт OpenCode"}
        </span>
        <button
          className="icon-button"
          type="button"
          disabled={busy}
          onClick={() => setShowSettings(true)}
          aria-label="Настройки"
          title="Настройки"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 17h16" />
            <circle cx="9" cy="7" r="3" />
            <circle cx="15" cy="17" r="3" />
          </svg>
        </button>
      </div>
      {manual && (
        <label className="transcript">
          Сессия
          <select
            aria-label="Сессия"
            value={settings.sessionId}
            disabled={busy}
            onChange={(e) => {
              const next = { ...settings, sessionId: e.target.value };
              setSettings(next);
              try {
                localStorage.setItem(
                  "voice-overlay-settings:v1",
                  JSON.stringify(next),
                );
              } catch {
                setNotice("Выбор сессии не сохранён.");
              }
            }}
          >
            <option value="">Выберите сессию</option>
            {selectedSessionMissing && (
              <option value={settings.sessionId}>
                Недоступна — {settings.sessionId}
              </option>
            )}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}{session.directory ? ` — ${session.directory}` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => void loadSessions(settings)}
          >
            Обновить
          </button>
          {selectedSessionMissing && (
            <small className="field-note" role="alert">
              Сервер больше не возвращает выбранную сессию. Выберите другую или
              откройте актуальную вкладку через команду web.
            </small>
          )}
          {sessionListError && (
            <small className="field-note" role="alert">
              Не удалось обновить сессии: {sessionListError}
            </small>
          )}
        </label>
      )}
      <section className="recorder" aria-label="Голосовая запись">
        <div className="record-ring">
          <button
            className={`record-button ${status === "recording" ? "is-recording" : ""}`}
            type="button"
            disabled={starting || sending || status === "transcribing"}
            aria-label={
              status === "recording" ? "Остановить запись" : "Начать запись"
            }
            onClick={() =>
              status === "recording" ? void onStop(false) : void onRecord()
            }
          >
            {status === "transcribing" || starting ? (
              <span className="spinner" aria-hidden="true" />
            ) : status === "recording" ? (
              <span className="stop-icon" aria-hidden="true" />
            ) : (
              <svg
                viewBox="0 0 32 32"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <rect x="11" y="4" width="10" height="16" rx="5" />
                <path d="M7 15v1a9 9 0 0 0 18 0v-1M16 25v4M12 29h8" />
              </svg>
            )}
          </button>
        </div>
        <h1>
          {starting
            ? "Подключаем микрофон"
            : status === "recording"
              ? "Слушаю вас"
              : status === "transcribing"
                ? "Распознаю речь"
                : "Скажите, что сделать"}
        </h1>
        <p className="record-hint" role="status">
          {starting
            ? "Ещё немного…"
            : status === "recording"
              ? "Нажмите, чтобы завершить запись"
              : status === "transcribing"
                ? "Обрабатываю запись на устройстве"
                : "Нажмите на микрофон и начните говорить"}
        </p>
        <div
          className={`record-meter ${status === "recording" ? "is-active" : ""}`}
        >
          <span className="status-dot" aria-hidden="true" />
          <span>
            {status === "recording"
              ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`
              : "До 2 минут"}
          </span>
          <span className="meter-divider">·</span>
          <span>Локально</span>
        </div>
      </section>
      {recognizing && (
        <button
          type="button"
          className="send-button"
          disabled={cancelling}
          onClick={() => void onCancel()}
        >
          {cancelling ? "Отменяем…" : "Отменить распознавание"}
        </button>
      )}
      {preview !== "" && (
        <section className="transcript">
          <label className="section-label" htmlFor="voice-draft">
            Распознанный текст — можно исправить
          </label>
          <textarea
            id="voice-draft"
            value={preview}
            disabled={busy}
            onChange={(e) => setPreview(e.target.value)}
            rows={4}
          />
          <div className="transcript-actions">
            <button type="button" onClick={() => void onCopy()}>
              Копировать
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPreview("");
                setNotice(null);
              }}
            >
              Удалить
            </button>
            <button
              type="button"
              disabled={
                !canSend ||
                (settings.target === "web" && settings.sessionId === "")
              }
              onClick={() => void onSend()}
            >
              {settings.target === "web"
                ? "Отправить в сессию"
                : "Повторить вставку в TUI"}
            </button>
          </div>
        </section>
      )}
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <div className="error-card" role="alert">
          <p>{error}</p>
          {errorDetail && (
            <details>
              <summary>Подробности ошибки</summary>
              <pre>{errorDetail}</pre>
            </details>
          )}
        </div>
      )}
      <footer className="overlay-footer">
        {settings.postTranscriptionAction === "insert-and-submit"
          ? "Вставка и отправка после распознавания"
          : !manual
            ? "Текст появится в строке ввода"
            : "Отправка после вашего подтверждения"}
      </footer>
    </main>
  );
}
