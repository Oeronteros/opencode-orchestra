import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import { DEFAULT_LOCALE, LOCALES, LOCALE_CODES, resolveLocale, type LocaleCode } from "./lib/locales"

export const LANGUAGE_STORAGE_KEY = "orchestra-language"

const resources = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, { translation: LOCALES[code] }]),
)

/** localStorage throws in private-mode/sandboxed frames; fall back silently. */
function storedLanguage(): LocaleCode {
  try {
    return resolveLocale(localStorage.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    return DEFAULT_LOCALE
  }
}

void i18n.use(initReactI18next).init({
  resources,
  lng: storedLanguage(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALE_CODES],
  interpolation: { escapeValue: false },
})

/** Persist the choice so a reload keeps the language, then switch at runtime. */
export function setLanguage(code: LocaleCode): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code)
  } catch {
    // Non-fatal: the language still changes for this session.
  }
  void i18n.changeLanguage(code)
}

/** The other supported language, for the two-way toggle in the top bar. */
export function nextLanguage(current: string): LocaleCode {
  return resolveLocale(current) === "ru" ? "en" : "ru"
}

export default i18n
