export const VOICE_HOTKEY = "Ctrl+Alt+Space";

export interface InputTarget {
  window: number;
  focus: number;
  process: number;
  title: string;
}

export type HotkeyAction = "start" | "stop" | "retry" | "ignore";

/** Busy transitions must never start a second recorder or submit a prompt. */
export function hotkeyAction(status: string, busy: boolean, pending: boolean): HotkeyAction {
  if (busy || status === "transcribing") return "ignore";
  if (status === "recording") return "stop";
  return pending ? "retry" : "start";
}

export function nativeInputDefault(platform: string, saved: unknown): boolean {
  return /win|linux/i.test(platform) && saved !== false;
}

export function autoInsertDefault(saved: unknown): boolean {
  return saved !== false;
}

export function parseVoiceDraft(value: unknown): { text: string; target: InputTarget | null } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  if (raw.target === null) return { text: raw.text, target: null };
  if (!raw.target || typeof raw.target !== "object") return null;
  const target = raw.target as Record<string, unknown>;
  if (![target.window, target.focus, target.process].every(n => typeof n === "number" && Number.isSafeInteger(n)) || typeof target.title !== "string") return null;
  return { text: raw.text, target: target as unknown as InputTarget };
}
