import assert from "node:assert/strict";
import { it } from "node:test";
import { EMPTY_WIDGET, widgetCopy } from "../src/lib/widget.js";

it("shows recording state and elapsed time, and a distinct processing state", () => {
  assert.deepEqual(widgetCopy({ ...EMPTY_WIDGET, status: "recording", elapsed: 65 }), {
    label: "Идёт запись", hint: "1:05 · Стоп", action: "Остановить запись",
  });
  assert.equal(widgetCopy({ ...EMPTY_WIDGET, status: "transcribing", pending: true }).action, "Распознавание речи");
  assert.equal(widgetCopy({ ...EMPTY_WIDGET, status: "starting" }).action, "Подключение микрофона");
});

it("offers insertion instead of a new recording when a failed or restored draft remains", () => {
  for (const status of ["idle", "error"] as const) {
    assert.equal(widgetCopy({ ...EMPTY_WIDGET, status, pending: true }).action, "Вставить сохранённый текст");
  }
  assert.equal(widgetCopy({ ...EMPTY_WIDGET, status: "error", pending: false }).action, "Повторить запись");
  assert.equal(widgetCopy(EMPTY_WIDGET).action, "Начать запись");
});
