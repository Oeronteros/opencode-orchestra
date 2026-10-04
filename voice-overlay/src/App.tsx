import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  appendToPrompt,
  enableVoiceHotkey,
  pasteVoiceText,
  browserTarget,
  insertInBrowser,
  type BrowserTarget,
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
import { hotkeyAction, parseVoiceDraft, VOICE_HOTKEY, type InputTarget } from "./lib/hotkey";

const DRAFT_KEY = "voice-overlay-native-draft:v1";
function loadVoiceDraft() {
  try { return parseVoiceDraft(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null")); }
  catch { return null; }
}

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
  const [restoredDraft] = useState(loadVoiceDraft);
  const [settings, setSettings] = useState<OverlaySettings>(loadSettings);
  const [devices, setDevices] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [sessionListError, setSessionListError] = useState<string | null>(null);
  const [status, setStatus] = useState<OverlayStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>(restoredDraft?.text ?? "");
  const [hasNativeDraft, setHasNativeDraft] = useState(restoredDraft !== null);
  const [hotkeyReady, setHotkeyReady] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const recordingNative = useRef<InputTarget | null>(null);
  const draftNative = useRef<InputTarget | null>(restoredDraft?.target ?? null);
  const onHotkey = useRef<(target: InputTarget | null) => void>(() => {});
  const [showSettings, setShowSettings] = useState(false);
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const operation = useRef(false);
  const timer = useRef<number | null>(null);
  const invocation = useRef<OverlaySettings>(settings);
  const draftDestination = useRef<OverlaySettings | null>(null);
  const [detectedSession, setDetectedSession] = useState<BrowserTarget | null>(null);
  const recordingTab = useRef<BrowserTarget | null>(null);
  const draftTab = useRef<BrowserTarget | null>(null);
  const sessionRequest = useRef(0);
  const manual = settings.target === "web";

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listen<string>("voice-hotkey-error", event => {
      setError(event.payload);
      setStatus(current => current === "recording" || current === "transcribing" ? current : "error");
    }).then(unlisten => { if (disposed) unlisten(); else cleanup = unlisten; }).catch(() => {});
    return () => { disposed = true; cleanup?.(); };
  }, []);

  const reconnectHotkey = async () => {
    setHotkeyError(null);
    try { setHotkeyReady(await enableVoiceHotkey()); }
    catch (e) { setHotkeyReady(false); setHotkeyError(String(e)); }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<InputTarget | null>("voice-hotkey", event => onHotkey.current(event.payload))
      .then(async cleanup => {
        if (disposed) { cleanup(); return; }
        unlisten = cleanup;
        try {
          const ready = await enableVoiceHotkey();
          if (!disposed) setHotkeyReady(ready);
        } catch (e) { if (!disposed) setHotkeyError(String(e)); }
      }).catch(e => { if (!disposed) setHotkeyError(String(e)); });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    try {
      if (hasNativeDraft && preview.trim()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: preview, target: draftNative.current }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* The editable result is still available in this window. */ }
  }, [preview, hasNativeDraft]);

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

  const onRecord = async (nativeTarget: InputTarget | null = null) => {
    if (operation.current) return;
    operation.current = true;
    setStarting(true);
    setError(null);
    setErrorDetail(null);
    setNotice(null);
    invocation.current = { ...settings };
    recordingTab.current = null;
    recordingNative.current = nativeTarget;
    try {
      if (hasNativeDraft && preview.trim()) throw new Error("Сначала вставьте или удалите сохранённый текст. Для вставки вернитесь в исходное поле и нажмите Ctrl+Alt+Space.");
      if (preview.trim() && draftTab.current) {
        throw new Error("Сначала вставьте или удалите предыдущий текст — его вкладка сохранена.");
      }
      if (!settings.nativeInput && settings.target === "auto") {
        setDetectedSession(null);
        const session = await browserTarget({ ...settings, port: settings.browserPort });
        setDetectedSession(session);
        recordingTab.current = session;
        setNotice(`Поле ввода: ${session.title || session.route}`);
      }
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
        text = await transcribe(wav, settings.model, settings.language);
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
      if (settings.nativeInput) {
        draftNative.current = recordingNative.current;
        setHasNativeDraft(true);
        setPreview(text);
        try {
          const inserted = await pasteVoiceText(settings.autoInsert ? draftNative.current : null, text);
          if (inserted) {
            setPreview("");
            setHasNativeDraft(false);
            draftNative.current = null;
          }
          setNotice(inserted
            ? "Текст вставлен в активное поле OpenCode. Отправку нажимаете вы."
            : "Текст сохранён и скопирован. Проверьте его, вернитесь в поле и нажмите Ctrl+Alt+Space для вставки.");
          setStatus("idle");
        } catch (e) { fail(String(e)); }
        return;
      }
      draftDestination.current = settings.target === "auto" ? { ...settings } : null;
      draftTab.current = recordingTab.current;
      setPreview((previous) =>
        settings.target === "web" && previous ? `${previous}\n${text}` : text,
      );
      if (!settings.autoInsert) {
        setNotice("Автовставка выключена. Проверьте текст и нажмите кнопку вставки.");
        setStatus("idle");
        return;
      }
      if (settings.target === "auto") {
        try {
          if (!recordingTab.current) throw new Error("Исходная вкладка не определена. Текст сохранён.");
          await insertInBrowser({ ...settings, port: settings.browserPort }, recordingTab.current, text);
          setPreview("");
          draftDestination.current = null;
          draftTab.current = null;
          setNotice("Текст вставлен в поле ввода открытой вкладки. Нажмите отправку в OpenCode, когда будете готовы.");
          setStatus("idle");
        } catch (e) { fail(String(e)); }
        return;
      }
      if (settings.target === "web") {
        if (
          settings.postTranscriptionAction === "insert-and-submit" &&
          settings.sessionId !== ""
        ) {
          try {
            await sendToSession(settings, settings.sessionId, text);
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

  const onSend = async (nativeTarget: InputTarget | null = null) => {
    // Retrying a recording must keep its original server and session.
    const target = draftDestination.current ?? settings;
    if (
      operation.current ||
      !preview.trim() ||
      (!hasNativeDraft && target.target === "web" && target.sessionId === "") ||
      (!hasNativeDraft && target.target === "auto" && !draftTab.current)
    )
      return;
    operation.current = true;
    setSending(true);
    setError(null);
    try {
      if (hasNativeDraft) {
        const destination = draftNative.current ?? nativeTarget;
        if (!destination) throw new Error("Вернитесь в поле ввода OpenCode и нажмите Ctrl+Alt+Space либо вставьте текст через Ctrl+V.");
        draftNative.current = destination;
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: preview, target: destination })); } catch { /* Keep the in-memory draft. */ }
        const inserted = await pasteVoiceText(destination, preview);
        if (!inserted) throw new Error("Вставьте текст через Ctrl+V.");
        setPreview("");
        setHasNativeDraft(false);
        draftNative.current = null;
        setNotice("Текст вставлен. Отправку нажимаете вы.");
      } else if (target.target === "auto" && draftTab.current) {
        await insertInBrowser({ ...target, port: target.browserPort }, draftTab.current, preview);
        setNotice("Текст вставлен в исходную вкладку. Отправьте его из OpenCode.");
        setPreview("");
        draftDestination.current = null;
        draftTab.current = null;
      } else if (target.target === "web") {
        await sendToSession(target, target.sessionId, preview);
        setNotice("Отправлено в сессию");
        setPreview("");
        draftDestination.current = null;
      } else {
        await appendToPrompt(target, preview);
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

  onHotkey.current = target => {
    setHotkeyReady(true);
    setHotkeyError(null);
    if (showSettings) return;
    switch (hotkeyAction(status, operation.current, hasNativeDraft && !!preview.trim())) {
      case "stop": void onStop(); break;
      case "retry": void onSend(target); break;
      case "start":
        if (settings.nativeInput && !target) { fail("Поставьте курсор в поле ввода OpenCode и нажмите Ctrl+Alt+Space."); return; }
        void onRecord(target);
        break;
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
          {settings.nativeInput ? "OpenCode 2 · TUI / Desktop / Web" : settings.target === "auto" ? "Открытая вкладка" : settings.target === "web" ? "Web-сессия" : "Промпт OpenCode"}
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
      {settings.nativeInput && <p className="notice" role="status">
        {hotkeyReady ? `${VOICE_HOTKEY} — начать / остановить. Сначала поставьте курсор в нужное поле ввода.` : hotkeyError ? "Глобальный хоткей недоступен. Подробности ниже." : "Подключаем глобальный хоткей…"}
      </p>}
      <label className="auto-insert-toggle">
        <span>Автовставка в поле сессии</span>
        <input type="checkbox" role="switch" checked={settings.autoInsert} disabled={busy}
          onChange={event => {
            const next = { ...settings, autoInsert: event.target.checked };
            setSettings(next);
            try { localStorage.setItem("voice-overlay-settings:v1", JSON.stringify(next)); }
            catch { setNotice("Не удалось сохранить настройку автовставки."); }
          }} />
      </label>
      {hotkeyError && <p className="error-card" role="alert">{hotkeyError} <button type="button" disabled={busy} onClick={() => void reconnectHotkey()}>Повторить подключение</button></p>}
      {settings.target === "auto" && (
        <p className="notice" role="status">
          {detectedSession
            ? `Вкладка записи: ${detectedSession.title || detectedSession.route}`
            : "Откройте нужную вкладку OpenCode через voice-web, затем нажмите микрофон. Текст появится в её поле ввода."}
        </p>
      )}
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
                draftDestination.current = null;
                draftTab.current = null;
                draftNative.current = null;
                setHasNativeDraft(false);
                setNotice(null);
              }}
            >
              Удалить
            </button>
            {!hasNativeDraft && <button
              type="button"
              disabled={
                !canSend ||
                ((draftDestination.current ?? settings).target === "web" &&
                  (draftDestination.current ?? settings).sessionId === "")
              }
              onClick={() => void onSend()}
            >
              {(draftDestination.current ?? settings).target === "auto"
                ? "Повторить вставку в исходную вкладку"
                : (draftDestination.current ?? settings).target === "web"
                ? "Отправить в сессию"
                : "Повторить вставку в TUI"}
            </button>}
          </div>
          {hasNativeDraft && <p className="field-note">Вернитесь в исходное поле и нажмите Ctrl+Alt+Space для вставки сохранённого текста.</p>}
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
        {settings.nativeInput ? "Обычная вставка через буфер обмена. Без отправки и без порта сервера." : settings.target === "auto" ? "Текст вставится в открытую вкладку. Отправку нажимаете вы."
          : settings.postTranscriptionAction === "insert-and-submit"
          ? "Вставка и отправка после распознавания"
          : settings.target === "tui"
            ? "Текст появится в строке ввода"
            : "Отправка после вашего подтверждения"}
      </footer>
    </main>
  );
}
