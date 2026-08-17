import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-2xl border border-white/[0.08] bg-[#10131a]/85 shadow-[0_24px_80px_-48px_rgba(0,0,0,.9)]", className)} {...props} />
}
