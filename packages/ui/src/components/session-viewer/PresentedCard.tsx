import * as React from "react";
import { StarIcon, MapPinIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import type { PresentedCard as PresentedCardData, CardRating } from "@/components/session-viewer/presented-card";
import { isExternalImage } from "@/components/session-viewer/presented-card";

/**
 * A read-only entity the model presented — a person, business, place, event,
 * or product — normalized from a schema.org entity into one unified card.
 *
 * No fetch, no interaction beyond safe links; the type-specific bits (rating
 * stars, price/hours badges, address, derived call/email/directions actions)
 * come from the normalizer, so this component just lays them out.
 */
/** A single card, standalone (owns its vertical margin). */
export function PresentedCard({ card }: { card: PresentedCardData }) {
  return (
    <div className="my-2">
      <PresentedCardBody card={card} />
    </div>
  );
}

/**
 * One or many cards from a single present_card call. Multiple entities (e.g. a
 * search returning several businesses) stack with a count header.
 */
export function PresentedCardGroup({ cards }: { cards: PresentedCardData[] }) {
  if (cards.length === 0) return null;
  if (cards.length === 1) return <PresentedCard card={cards[0]!} />;
  return (
    <div className="my-2 space-y-2">
      <div className="px-0.5 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
        {cards.length} results
      </div>
      {cards.map((card, i) => (
        <PresentedCardBody key={i} card={card} />
      ))}
    </div>
  );
}

function PresentedCardBody({ card }: { card: PresentedCardData }) {
  // ponytail: only gate http/https images; data:/relative would render directly
  const [imageApproved, setImageApproved] = React.useState(false);
  const isExternal = !!card.image && isExternalImage(card.image);
  const showImg = !!card.image && (!isExternal || imageApproved);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-start gap-3 border-b border-border bg-muted/40 px-3 py-2.5">
        {showImg ? (
          <img
            src={card.image}
            alt=""
            referrerPolicy="no-referrer"
            className={cn("size-10 shrink-0 object-cover", card.kind === "person" ? "rounded-full" : "rounded-md")}
          />
        ) : isExternal ? (
          // External image: show kind icon + click affordance (no auto-fetch)
          <button
            type="button"
            title="Load image"
            onClick={() => setImageApproved(true)}
            className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md bg-muted hover:bg-muted/70"
          >
            <DynamicLucideIcon name={card.icon} className="size-5 text-muted-foreground" />
          </button>
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <DynamicLucideIcon name={card.icon} className="size-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-tight">{card.title}</div>
          {card.subtitle && <div className="truncate text-xs text-muted-foreground">{card.subtitle}</div>}
          {(card.rating || card.badges.length > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              {card.rating && <RatingStars rating={card.rating} />}
              {card.badges.map((badge, i) => (
                <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                  {badge}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {(card.description || card.address || card.fields.length > 0) && (
        <div className="space-y-2 px-3 py-2.5">
          {card.description && (
            <p className="text-sm leading-snug text-muted-foreground line-clamp-3">{card.description}</p>
          )}
          {card.address && (
            <div className="flex items-start gap-1.5 text-sm">
              <MapPinIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-words">{card.address}</span>
            </div>
          )}
          {card.fields.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              {card.fields.map((field, i) => (
                <React.Fragment key={i}>
                  <dt className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">{field.label}</dt>
                  <dd className="min-w-0 break-words">{field.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
        </div>
      )}

      {card.actions.length > 0 && (
        <div className={cn("flex flex-wrap gap-2 px-3 pb-3", !card.description && !card.address && card.fields.length === 0 && "pt-3")}>
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

/** Five-star rating with a half-star for the fraction, plus the count. */
function RatingStars({ rating }: { rating: CardRating }) {
  const outOfFive = Math.max(0, Math.min(5, (rating.value / rating.max) * 5));
  const full = Math.floor(outOfFive);
  const half = outOfFive - full >= 0.5;
  return (
    <span className="flex items-center gap-0.5 text-amber-500" title={`${rating.value} / ${rating.max}`}>
      {Array.from({ length: 5 }).map((_, i) => {
        const filled = i < full;
        const isHalf = i === full && half;
        return (
          <span key={i} className="relative inline-flex">
            <StarIcon className="size-3.5" strokeWidth={1.5} />
            {(filled || isHalf) && (
              <span className={cn("absolute inset-0 overflow-hidden", isHalf && "w-1/2")}>
                <StarIcon className="size-3.5 fill-amber-500" strokeWidth={1.5} />
              </span>
            )}
          </span>
        );
      })}
      {rating.count != null && <span className="ml-0.5 text-[0.65rem] text-muted-foreground">({rating.count})</span>}
    </span>
  );
}
