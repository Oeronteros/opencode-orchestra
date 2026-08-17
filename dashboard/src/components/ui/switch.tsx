import { Switch as BaseSwitch } from "@base-ui/react/switch"
import type { ComponentProps } from "react"

export function Switch(props: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      {...props}
      className="relative h-6 w-11 rounded-full bg-zinc-700 transition-colors data-[checked]:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
    >
      <BaseSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[checked]:translate-x-5" />
    </BaseSwitch.Root>
  )
}
