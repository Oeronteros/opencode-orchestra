import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] backdrop-blur-xl",
        "shadow-[0_8px_32px_rgba(0,0,0,0.3)]",
        "transition-all duration-300 ease-out",
        "hover:border-[var(--border-medium)] hover:shadow-[var(--shadow-lg)]",
        className
      )}
      {...props}
    />
  )
}
