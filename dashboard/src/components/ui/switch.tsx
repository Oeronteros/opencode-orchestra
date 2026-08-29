import { Switch as BaseSwitch } from "@base-ui/react/switch"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

export function Switch(props: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      {...props}
      className={cn(
        "relative h-6 w-11 rounded-full transition-all duration-300 ease-out",
        "bg-zinc-700/50 border border-white/[0.06]",
        "data-[checked]:bg-gradient-to-r data-[checked]:from-violet-600 data-[checked]:to-violet-500",
        "data-[checked]:border-violet-500/30",
        "data-[checked]:shadow-[0_0_16px_rgba(139,92,246,0.3)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        "hover:border-white/[0.1]",
        "data-[checked]:hover:border-violet-400/40"
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          "block size-5 translate-x-0.5 rounded-full bg-white shadow-lg transition-all duration-300 ease-out",
          "data-[checked]:translate-x-[22px]",
          "data-[checked]:shadow-[0_2px_8px_rgba(0,0,0,0.3)]"
        )}
      />
    </BaseSwitch.Root>
  )
}
