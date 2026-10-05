export interface WidgetSnapshot {
  enabled: boolean;
  status: "idle" | "starting" | "recording" | "transcribing" | "error";
  elapsed: number;
  blocked: boolean;
  pending: boolean;
  message: string | null;
}

export const EMPTY_WIDGET: WidgetSnapshot = {
  enabled: false, status: "idle", elapsed: 0, blocked: true, pending: false, message: null,
};

export function widgetCopy(state: WidgetSnapshot): { label: string; hint: string; action: string } {
  if (state.status === "starting") return { label: "Подключаем…", hint: "Микрофон", action: "Подключение микрофона" };
  if (state.status === "recording") {
    const seconds = Math.max(0, Math.floor(state.elapsed));
    return { label: "Идёт запись", hint: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · Стоп`, action: "Остановить запись" };
  }
  if (state.status === "transcribing") return { label: "Распознаём…", hint: "Локально", action: "Распознавание речи" };
  if (state.pending) return { label: "Вставить текст", hint: "Черновик сохранён", action: "Вставить сохранённый текст" };
  if (state.status === "error") return { label: "Повторить", hint: "Ошибка · см. окно", action: "Повторить запись" };
  return { label: "Голосовой ввод", hint: "Нажмите и говорите", action: "Начать запись" };
}
