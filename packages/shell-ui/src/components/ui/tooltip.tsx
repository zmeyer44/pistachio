import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "../../lib/cn";

/**
 * shadcn's Tooltip on Base UI (ui.shadcn.com/docs/components/base/tooltip),
 * in the inverted Geist colours the default Button uses. The provider
 * groups tooltips: once one has shown, moving to a neighbour's trigger shows
 * its tooltip at once. It animates on Base UI's own starting and ending
 * styles (the shell has no tw-animate-css), and the popup renders into a
 * portal.
 */
function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} className="isolate z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "relative z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-gray-1000 px-2.5 py-1.5 text-label-12 text-background-100 shadow-menu transition-[opacity,scale] duration-150 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="size-2.5 rotate-45 rounded-[2px] bg-gray-1000 data-[side=bottom]:-top-1 data-[side=inline-end]:-left-1 data-[side=inline-start]:-right-1 data-[side=left]:-right-1 data-[side=right]:-left-1 data-[side=top]:-bottom-1" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
