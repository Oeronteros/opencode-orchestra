import { useEffect, useRef, useState } from "react";
import {
  appendToPrompt,
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

function codeOf(message: string): OverlayErrorCode | null {
  const head = message.split(": ")[0];
  const codes: OverlayErrorCode[] = [
    "no-mic", "no-ffmpeg", "no-audio-server", "model-missing",
    "server-unreachable", "unauthorized", "empty-transcript",
    "empty-recording", "too-long", "transcribe-failed",
    "no-session", "session-not-found",
  ];
  return (codes as string[]).includes(head ?? "") ? (head as OverlayErrorCode) : null;
}

export function App() {
  const [settings, setSettings] = useState<OverlaySettings>(loadSettings);
  const [devices, setDevices] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [status, setStatus] = useState<OverlayStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const operation = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (status !== "recording") return;
    const started = Date.now();
    setElapsed(0);
    const interval = window.setInterval(() => setElapsed(Math.min(MAX_SECONDS, Math.floor((Date.now() - started) / 1000))), 250);
    return () => window.clearInterval(interval);
  }, [status]);

  const loadSessions = async (cfg: OverlaySettings) => {
    try {
      setSessions(await listSessions(cfg));
    } catch {
      setSessions([]);
    }
  };

  useEffect(() => {
    listMicrophones().then(setDevices).catch(() => setDevices([]));
    void loadSessions(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const fail = (message: string) => {
    const code = codeOf(message);
    setError(code !== null ? errorCopy(code) : message);
    setErrorDetail(code !== null ? message.slice(message.indexOf(":") + 1).trim() : null);
    setStatus("error");
  };

  const onRecord = async () => {
    if (operation.current) return;
    operation.current = true;
    setStarting(true);
    setError(null);
    setErrorDetail(null);
    setNotice(null);
    setPreview("");
    try {
      await startRecording(settings.device === "" ? undefined : settings.device);
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
        text = await transcribe(wav, settings.model);
      } catch (e) {
        fail(String(e));
        return;
      }
      setPreview(text);
      if (settings.target === "web") {
        // No auto-send in web mode (spec Section 6): user confirms via send button.
        setNotice(auto ? "Достигнут лимит 120 секунд — нажми «Отправить в сессию»" : "Проверь текст и нажми «Отправить в сессию»");
        setStatus("idle");
        return;
      }
      try {
        await appendToPrompt(settings, text);
        setNotice(auto ? "Достигнут лимит 120 секунд — вставлено в промпт" : "Вставлено в промпт");
        setStatus("idle");
      } catch (e) {
        const message = String(e);
        if (message.startsWith("fallback:") || message.startsWith("server-unreachable:")) {
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
    if (settings.sessionId === "" || preview === "") return;
    setSending(true);
    setError(null);
    try {
      await sendToSession(settings, settings.sessionId, preview);
      setNotice("Отправлено в сессию");
      setPreview("");
      setStatus("idle");
    } catch (e) {
      const message = String(e);
      if (message.startsWith("fallback:") || message.startsWith("server-unreachable:")) {
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
      setSending(false);
    }
  };

  if (showSettings) {
    return (
      <SettingsView
        settings={settings}
        devices={devices}
        sessions={sessions}
        onChange={(next) => {
          setSettings(next);
          setError(null);
          setStatus("idle");
          void loadSessions(next);
          setShowSettings(false);
        }}
        onBack={() => setShowSettings(false)}
      />
    );
  }

  const busy = starting || sending || status === "recording" || status === "transcribing";
  const canSend = preview !== "" && settings.target === "web" && status === "idle" && !sending;
  return (
    <main className="overlay-shell" data-status={status}>
      <WindowHeader busy={busy} />
      <div className="toolbar">
        <span className="target-tag">{settings.target === "web" ? "Web-сессия" : "Промпт OpenCode"}</span>
        <button className="icon-button" type="button" disabled={busy} onClick={() => setShowSettings(true)} aria-label="Настройки" title="Настройки">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></svg>
        </button>
      </div>
      <section className="recorder" aria-label="Голосовая запись">
        <div className="record-ring">
          <button className={`record-button ${status === "recording" ? "is-recording" : ""}`} type="button"
            disabled={starting || sending || status === "transcribing"}
            aria-label={status === "recording" ? "Остановить запись" : "Начать запись"}
            onClick={() => status === "recording" ? void onStop(false) : void onRecord()}>
            {status === "transcribing" || starting ? <span className="spinner" aria-hidden="true" /> : status === "recording" ? <span className="stop-icon" aria-hidden="true" /> : (
              <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="11" y="4" width="10" height="16" rx="5"/><path d="M7 15v1a9 9 0 0 0 18 0v-1M16 25v4M12 29h8"/></svg>
            )}
          </button>
        </div>
        <h1>{starting ? "Подключаем микрофон" : status === "recording" ? "Слушаю вас" : status === "transcribing" ? "Распознаю речь" : "Скажите, что сделать"}</h1>
        <p className="record-hint" role="status">{starting ? "Ещё немного…" : status === "recording" ? "Нажмите, чтобы завершить запись" : status === "transcribing" ? "Обрабатываю запись на устройстве" : "Нажмите на микрофон и начните говорить"}</p>
        <div className={`record-meter ${status === "recording" ? "is-active" : ""}`}>
          <span className="status-dot" aria-hidden="true" />
          <span>{status === "recording" ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : "До 2 минут"}</span>
          <span className="meter-divider">·</span><span>Локально</span>
        </div>
      </section>
      {preview !== "" && <section className="transcript"><span className="section-label">Распознанный текст</span><p>{preview}</p></section>}
      {settings.target === "web" && preview !== "" && status === "idle" && (
        <button className="primary-button send-button" type="button" disabled={!canSend || settings.sessionId === ""} onClick={() => void onSend()}>
          Отправить в сессию
        </button>
      )}
      {notice !== null && <p className="notice" role="status">{notice}</p>}
      {error !== null && <div className="error-card" role="alert"><p>{error}</p>{errorDetail && <details><summary>Подробности ошибки</summary><pre>{errorDetail}</pre></details>}</div>}
      <footer className="overlay-footer">{settings.target === "tui" ? "Текст появится в строке ввода" : "Отправка после вашего подтверждения"}</footer>
    </main>
  );
}
