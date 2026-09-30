import { cn } from "@/lib/utils";

export interface DropZoneCell {
  /** Zone id, or null for an inert spacer cell. */
  pos: string | null;
  label: string;
}

/** 3×3 cells for dragging a toolbar button (center = header). */
export const BUTTON_DROP_ZONES: readonly DropZoneCell[] = [
  { pos: "left-top",      label: "Left\ntop"    },
  { pos: "center-top",    label: "Top"          },
  { pos: "right-top",     label: "Right\ntop"   },
  { pos: "left-middle",   label: "Left"         },
  { pos: "top",           label: "Header"       },
  { pos: "right-middle",  label: "Right"        },
  { pos: "left-bottom",   label: "Left\nbottom" },
  { pos: "center-bottom", label: "Bottom"       },
  { pos: "right-bottom",  label: "Right\nbottom"},
];

/** 3×3 cells for dragging a docked panel (center is not a drop target). */
export const PANEL_DROP_ZONES: readonly DropZoneCell[] = [
  { pos: "left-top",      label: "Left\ntop"    },
  { pos: "center-top",    label: "Top"          },
  { pos: "right-top",     label: "Right\ntop"   },
  { pos: "left-middle",   label: "Left"         },
  { pos: null,            label: ""             },
  { pos: "right-middle",  label: "Right"        },
  { pos: "left-bottom",   label: "Left\nbottom" },
  { pos: "center-bottom", label: "Bottom"       },
  { pos: "right-bottom",  label: "Right\nbottom"},
];

/** Non-interactive 3×3 drop-target overlay highlighting the zone under the pointer. */
export function DropZoneOverlay({
  zones,
  activeZone,
  className,
}: {
  zones: readonly DropZoneCell[];
  activeZone: string | null;
  className: string;
}) {
  return (
    <div className={className}>
      {zones.map((zone, idx) => {
        if (zone.pos === null) {
          return <div key={idx} />;
        }
        const isActive = activeZone === zone.pos;
        return (
          <div
            key={zone.pos}
            className={cn(
              "flex items-center justify-center border transition-colors duration-100",
              isActive
                ? "bg-blue-500/20 border-blue-500"
                : "bg-zinc-900/40 border-zinc-700/30",
            )}
          >
            <span className={cn(
              "text-[10px] font-medium text-center transition-colors whitespace-pre-line leading-tight",
              isActive ? "text-blue-300" : "text-zinc-600",
            )}>
              {zone.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
