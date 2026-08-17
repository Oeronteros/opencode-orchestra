import { create } from "zustand"

type Theme = "dark" | "light"

interface UiState {
  theme: Theme
  compact: boolean
  setTheme: (theme: Theme) => void
  toggleCompact: () => void
}

const storedTheme = localStorage.getItem("orchestra-theme") === "light" ? "light" : "dark"

export const useUiStore = create<UiState>((set) => ({
  theme: storedTheme,
  compact: false,
  setTheme: (theme) => {
    localStorage.setItem("orchestra-theme", theme)
    set({ theme })
  },
  toggleCompact: () => set((state) => ({ compact: !state.compact })),
}))
