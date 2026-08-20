import { create } from "zustand"

type Theme = "dark" | "light"

interface UiState {
  theme: Theme
  compact: boolean
  selectedProject: string
  setTheme: (theme: Theme) => void
  setSelectedProject: (project: string) => void
  toggleCompact: () => void
}

const storedTheme = localStorage.getItem("orchestra-theme") === "light" ? "light" : "dark"

export const useUiStore = create<UiState>((set) => ({
  theme: storedTheme,
  compact: false,
  selectedProject: localStorage.getItem("orchestra-project") ?? "global",
  setTheme: (theme) => {
    localStorage.setItem("orchestra-theme", theme)
    set({ theme })
  },
  setSelectedProject: (selectedProject) => {
    localStorage.setItem("orchestra-project", selectedProject)
    set({ selectedProject })
  },
  toggleCompact: () => set((state) => ({ compact: !state.compact })),
}))
