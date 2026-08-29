import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-white/[0.06] bg-[rgba(12,15,22,0.75)] backdrop-blur-xl",
        "shadow-[0_8px_32px_rgba(0,0,0,0.3)]",
        "transition-all duration-300 ease-out",
        "hover:border-white/[0.1] hover:shadow-[0_16px_64px_rgba(0,0,0,0.4)]",
        className
      )}
      {...props}
    />
  )
}
