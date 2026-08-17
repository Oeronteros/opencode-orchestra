import { Button as BaseButton } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

const buttonVariants = cva(
  "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-violet-500 text-white hover:bg-violet-400",
        outline: "border border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.07]",
        ghost: "text-zinc-400 hover:bg-white/[0.05] hover:text-white",
      },
    },
    defaultVariants: { variant: "primary" },
  },
)

export function Button({ className, variant, ...props }: ComponentProps<typeof BaseButton> & VariantProps<typeof buttonVariants>) {
  return <BaseButton className={cn(buttonVariants({ variant }), className)} {...props} />
}
