import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import type { PresentedCard as PresentedCardData } from "@/components/session-viewer/presented-card";

/**
 * A read-only entity the model chose to present — a contact, place, or event.
 *
 * The display sibling of ArtifactCard: no fetch, no interaction beyond safe
 * links; everything renders from the tool input the model supplied.
 */
export function PresentedCard({ card }: { card: PresentedCardData }) {
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-2.5">
        {card.image ? (
          <img
            src={card.image}
            alt=""
            referrerPolicy="no-referrer"
            className="size-9 shrink-0 rounded-full object-cover"
          />
        ) : card.icon ? (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
            <DynamicLucideIcon name={card.icon} className="size-4 text-muted-foreground" />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{card.title}</div>
          {card.subtitle && <div className="truncate text-xs text-muted-foreground">{card.subtitle}</div>}
        </div>
      </div>

      {card.fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm">
          {card.fields.map((field, i) => (
            <React.Fragment key={i}>
              <dt className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-words">{field.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}

      {card.actions.length > 0 && (
        <div className={cn("flex flex-wrap gap-2 px-3 pb-3", card.fields.length === 0 && "pt-3")}>
          {card.actions.map((action, i) => (
            <Button key={i} asChild size="sm" variant="outline" className="gap-1.5">
              <a href={action.href} target="_blank" rel="noopener noreferrer nofollow">
                {action.icon && <DynamicLucideIcon name={action.icon} className="size-3.5" />}
                {action.label}
              </a>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
