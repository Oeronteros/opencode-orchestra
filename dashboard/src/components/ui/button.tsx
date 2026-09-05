import { Button as BaseButton } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

const buttonVariants = cva(
  "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: cn(
          "bg-gradient-to-r from-violet-600 to-violet-500 text-white",
          "hover:from-violet-500 hover:to-violet-400",
          "shadow-[0_4px_16px_rgba(139,92,246,0.3)]",
          "hover:shadow-[0_8px_24px_rgba(139,92,246,0.4)]",
          "hover:translate-y-[-1px]",
          "active:translate-y-0 active:shadow-[0_2px_8px_rgba(139,92,246,0.3)]"
        ),
        outline: cn(
          "border border-[var(--border-medium)] bg-[var(--bg-glass)] text-[var(--text-secondary)]",
          "hover:bg-[var(--bg-glass-hover)] hover:border-[var(--border-accent)]",
          "hover:shadow-[0_4px_16px_rgba(0,0,0,0.2)]"
        ),
        ghost: cn(
          "text-[var(--text-secondary)]",
          "hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]",
          "hover:shadow-[0_2px_8px_rgba(0,0,0,0.15)]"
        ),
      },
    },
    defaultVariants: { variant: "primary" },
  },
)

export function Button({ className, variant, ...props }: ComponentProps<typeof BaseButton> & VariantProps<typeof buttonVariants>) {
  return <BaseButton className={cn(buttonVariants({ variant }), className)} {...props} />
}
