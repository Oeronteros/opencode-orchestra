import i18n from "i18next"
import { initReactI18next } from "react-i18next"

const resources = {
  ru: { translation: {
    overview: "Обзор",
    activity: "Журнал",
    models: "Модели",
    agents: "Агенты",
    settings: "Настройка",
    live: "Локально",
    sessions: "Сессии",
    calls: "Вызовы",
    tokens: "Токены",
    cost: "Стоимость",
    usage: "Использование за 30 дней",
    recent: "Последняя активность",
    noData: "Данные появятся после первого запуска агентов Orchestra.",
  } },
  en: { translation: {
    overview: "Overview",
    activity: "Activity",
    models: "Models",
    agents: "Agents",
    settings: "Settings",
    live: "Local",
    sessions: "Sessions",
    calls: "Calls",
    tokens: "Tokens",
    cost: "Cost",
    usage: "Usage over 30 days",
    recent: "Recent activity",
    noData: "Data will appear after Orchestra agents run for the first time.",
  } },
} as const

void i18n.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem("orchestra-language") === "en" ? "en" : "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
})

export default i18n
