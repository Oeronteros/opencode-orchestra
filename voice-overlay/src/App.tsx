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
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [sending, setSending] = useState(false);
  const timer = useRef<number | null>(null);

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
    setStatus("error");
  };

  const onRecord = async () => {
    setError(null);
    setNotice(null);
    setPreview("");
    try {
      await startRecording(settings.device === "" ? undefined : settings.device);
    } catch (e) {
      fail(String(e));
      return;
    }
    setStatus("recording");
    timer.current = window.setTimeout(() => {
      void onStop(true);
    }, MAX_SECONDS * 1000);
  };

  const onStop = async (auto = false) => {
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

  const busy = status === "recording" || status === "transcribing";
  const canSend = preview !== "" && settings.target === "web" && status === "idle" && !sending;
  return (
    <main>
      {status === "recording" ? (
        <button type="button" onClick={() => void onStop(false)}>
          Stop
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void onRecord()}>
          Record
        </button>
      )}
      <button type="button" disabled={busy} onClick={() => setShowSettings(true)}>
        ⚙
      </button>
      <span>{status}</span>
      {preview !== "" && <p>{preview}</p>}
      {settings.target === "web" && preview !== "" && status === "idle" && (
        <button type="button" disabled={!canSend || settings.sessionId === ""} onClick={() => void onSend()}>
          Отправить в сессию
        </button>
      )}
      {notice !== null && <p>{notice}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </main>
  );
}
