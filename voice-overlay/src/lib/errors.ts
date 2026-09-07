export const ERROR_CODES = [
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
] as const;

export type OverlayErrorCode = (typeof ERROR_CODES)[number];

const COPY: Record<OverlayErrorCode, string> = {
  "no-mic": "Микрофон не найден. Подключи устройство и выбери его в настройках.",
  "no-ffmpeg": "Не найден ffmpeg. Установи его и перезапусти приложение.",
  "no-audio-server": "Нет доступа к звуковому серверу. Проверь PulseAudio или PipeWire: выполни pactl info.",
  "model-missing": "Модель распознавания не скачана. Нажми «Скачать модель» в настройках (нужен интернет один раз).",
  "server-unreachable": "Сервер opencode недоступен. Запусти opencode с фиксированным портом: opencode --port 4096.",
  "unauthorized": "Неверный пароль сервера. Проверь пароль в настройках (OPENCODE_SERVER_PASSWORD).",
  "empty-transcript": "Речь не распознана. Попробуй говорить громче и ближе к микрофону.",
  "empty-recording": "Запись пустая (короче полсекунды). Нажми Record, дождись и потом Stop.",
  "too-long": "Превышен лимит 120 секунд. Запись остановлена автоматически.",
  "transcribe-failed": "Ошибка распознавания. Попробуй ещё раз или выбери модель small в настройках.",
  "no-session": "Нет ни одной сессии. Создай сессию в opencode web и обнови список.",
  "session-not-found": "Сессия не найдена (удалена?). Обнови список и выбери снова.",
};

export function errorCopy(code: OverlayErrorCode): string {
  return COPY[code];
}
