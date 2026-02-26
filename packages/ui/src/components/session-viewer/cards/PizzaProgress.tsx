import * as React from "react";

/**
 * All available pizza-making stages. We pick a subset based on
 * how many todo items there are so the pizza builds in lockstep.
 */
export const ALL_STAGES = [
  "crust",
  "sauce",
  "cheese",
  "pepperoni",
  "mushrooms",
  "olives",
  "peppers",
  "basil",
  "onions",
  "bake",
  "serve",
] as const;

/**
 * Pick pizza stages that match the total number of todo items.
 * Returns an array of stage names with length === total.
 */
export function getPizzaStages(total: number): string[] {
  if (total <= 0) return [];
  if (total === 1) return ["full pizza"];
  if (total === 2) return ["dough", "bake"];
  if (total === 3) return ["crust", "sauce & cheese", "bake"];

  // For 4+, we always have crust, sauce, cheese as the base,
  // then fill middle with toppings, and end with bake (+ serve if room).
  const base = ["crust", "sauce", "cheese"];
  const finishers = total >= 6 ? ["bake", "serve"] : ["bake"];
  const toppingSlots = total - base.length - finishers.length;

  const availableToppings = ["pepperoni", "mushrooms", "olives", "peppers", "basil", "onions"];
  const toppings: string[] = [];
  for (let i = 0; i < Math.max(0, toppingSlots); i++) {
    toppings.push(availableToppings[i % availableToppings.length]);
  }

  return [...base, ...toppings, ...finishers];
}

/** Return the label for a given done count. */
export function pizzaLayerLabel(doneCount: number, total: number): string {
  if (total === 0) return "No tasks yet";
  if (doneCount === 0) return "Empty plate — get cooking!";
  if (doneCount >= total) return "Pizza complete! 🎉";
  const stages = getPizzaStages(total);
  const stage = stages[doneCount] ?? stages[stages.length - 1];
  return `Adding ${stage}…`;
}

/** Map a stage name to a visual "category" for rendering. */
export function stageVisual(stage: string): "crust" | "sauce" | "cheese" | "topping" | "bake" | "serve" | "full" {
  switch (stage) {
    case "full pizza": return "full";
    case "dough": case "crust": return "crust";
    case "sauce": case "sauce & cheese": return "sauce";
    case "cheese": return "cheese";
    case "bake": return "bake";
    case "serve": return "serve";
    default: return "topping";
  }
}

/** Map a topping name to a renderer index. */
export const TOPPING_NAME_TO_IDX: Record<string, number> = {
  pepperoni: 0, mushrooms: 1, olives: 2, peppers: 3, basil: 4, onions: 5,
};

export function PizzaProgress({ done, total }: { done: number; total: number }) {
  const isComplete = total > 0 && done >= total;
  const stages = getPizzaStages(total);

  // Determine which visual elements have been "unlocked" so far
  const completedVisuals = new Set<string>();
  let toppingCount = 0;
  const toppingNames: string[] = [];
  for (let i = 0; i < done; i++) {
    const vis = stageVisual(stages[i]);
    completedVisuals.add(vis);
    if (vis === "topping") {
      toppingCount++;
      toppingNames.push(stages[i]);
    }
    // "sauce & cheese" unlocks both
    if (stages[i] === "sauce & cheese") completedVisuals.add("cheese");
    // "full" unlocks everything
    if (vis === "full") {
      completedVisuals.add("crust");
      completedVisuals.add("sauce");
      completedVisuals.add("cheese");
    }
  }

  const hasCrust = completedVisuals.has("crust") || completedVisuals.has("full");
  const hasSauce = completedVisuals.has("sauce") || completedVisuals.has("full");
  const hasCheese = completedVisuals.has("cheese") || completedVisuals.has("full");
  const hasBake = completedVisuals.has("bake");
  const hasServe = completedVisuals.has("serve");

  // Deterministic topping positions (scattered across the pizza)
  const toppingPositions = [
    { cx: 60, cy: 45 },
    { cx: 40, cy: 60 },
    { cx: 75, cy: 65 },
    { cx: 55, cy: 75 },
    { cx: 35, cy: 45 },
    { cx: 70, cy: 50 },
    { cx: 50, cy: 55 },
    { cx: 65, cy: 38 },
    { cx: 42, cy: 72 },
    { cx: 58, cy: 62 },
    { cx: 48, cy: 42 },
    { cx: 72, cy: 72 },
  ];

  // Topping render functions (cycling)
  const toppingRenderers = [
    // Pepperoni — red circles
    (pos: { cx: number; cy: number }, i: number) => (
      <circle key={`pep-${i}`} cx={pos.cx} cy={pos.cy} r="4" fill="#dc2626" stroke="#991b1b" strokeWidth="0.5" opacity="0.9">
        <animate attributeName="opacity" from="0" to="0.9" dur="0.4s" fill="freeze" />
      </circle>
    ),
    // Mushrooms — tan ovals
    (pos: { cx: number; cy: number }, i: number) => (
      <ellipse key={`mush-${i}`} cx={pos.cx} cy={pos.cy} rx="4" ry="3" fill="#d4a574" stroke="#a0845c" strokeWidth="0.5" transform={`rotate(${i * 30}, ${pos.cx}, ${pos.cy})`} opacity="0.9">
        <animate attributeName="opacity" from="0" to="0.9" dur="0.4s" fill="freeze" />
      </ellipse>
    ),
    // Olives — dark circles
    (pos: { cx: number; cy: number }, i: number) => (
      <g key={`olive-${i}`} opacity="0.9">
        <circle cx={pos.cx} cy={pos.cy} r="3.5" fill="#1a1a1a" stroke="#333" strokeWidth="0.5" />
        <circle cx={pos.cx} cy={pos.cy} r="1.5" fill="#4a5568" />
        <animate attributeName="opacity" from="0" to="0.9" dur="0.4s" fill="freeze" />
      </g>
    ),
    // Peppers — green crescents
    (pos: { cx: number; cy: number }, i: number) => (
      <path key={`pep-g-${i}`} d={`M${pos.cx - 4},${pos.cy} Q${pos.cx},${pos.cy - 5} ${pos.cx + 4},${pos.cy} Q${pos.cx},${pos.cy - 2} ${pos.cx - 4},${pos.cy}`} fill="#22c55e" stroke="#15803d" strokeWidth="0.5" transform={`rotate(${i * 45}, ${pos.cx}, ${pos.cy})`} opacity="0.9">
        <animate attributeName="opacity" from="0" to="0.9" dur="0.4s" fill="freeze" />
      </path>
    ),
    // Basil — green leaves
    (pos: { cx: number; cy: number }, i: number) => (
      <path key={`basil-${i}`} d={`M${pos.cx},${pos.cy - 4} Q${pos.cx + 5},${pos.cy} ${pos.cx},${pos.cy + 4} Q${pos.cx - 5},${pos.cy} ${pos.cx},${pos.cy - 4}`} fill="#16a34a" stroke="#166534" strokeWidth="0.3" transform={`rotate(${i * 60}, ${pos.cx}, ${pos.cy})`} opacity="0.85">
        <animate attributeName="opacity" from="0" to="0.85" dur="0.4s" fill="freeze" />
      </path>
    ),
    // Onions — purple rings
    (pos: { cx: number; cy: number }, i: number) => (
      <circle key={`onion-${i}`} cx={pos.cx} cy={pos.cy} r="3" fill="none" stroke="#a855f7" strokeWidth="1.5" opacity="0.8">
        <animate attributeName="opacity" from="0" to="0.8" dur="0.4s" fill="freeze" />
      </circle>
    ),
  ];

  // Build topping SVG elements
  const toppingsToRender: React.ReactNode[] = [];
  for (let t = 0; t < toppingCount; t++) {
    const name = toppingNames[t];
    const rendererIdx = (name && TOPPING_NAME_TO_IDX[name] !== undefined)
      ? TOPPING_NAME_TO_IDX[name]
      : t % toppingRenderers.length;
    const renderer = toppingRenderers[rendererIdx % toppingRenderers.length];
    const posIdx1 = (t * 2) % toppingPositions.length;
    const posIdx2 = (t * 2 + 1) % toppingPositions.length;
    toppingsToRender.push(renderer(toppingPositions[posIdx1], t * 2));
    toppingsToRender.push(renderer(toppingPositions[posIdx2], t * 2 + 1));
  }

  // Bake effect: warm golden overlay
  const bakeOverlay = hasBake && (
    <circle cx="55" cy="58" r="33" fill="#92400e" opacity="0.15">
      <animate attributeName="opacity" from="0" to="0.15" dur="0.6s" fill="freeze" />
    </circle>
  );

  return (
    <div className="flex flex-col items-center gap-1.5 py-3 md:py-1.5">
      <svg viewBox="0 0 110 110" className="w-24 h-24 md:w-16 md:h-16" aria-label={`Pizza progress: ${done}/${total}`}>
        {/* Plate — always visible */}
        <circle cx="55" cy="58" r="48" fill="#27272a" stroke="#3f3f46" strokeWidth="1.5" />
        <circle cx="55" cy="58" r="44" fill="#18181b" stroke="#3f3f46" strokeWidth="0.5" />

        {/* Crust */}
        {hasCrust && (
          <circle cx="55" cy="58" r="40" fill="#d4a04a" stroke="#b8860b" strokeWidth="1">
            <animate attributeName="r" from="0" to="40" dur="0.5s" fill="freeze" />
          </circle>
        )}

        {/* Inner crust edge */}
        {hasCrust && (
          <circle cx="55" cy="58" r="34" fill="#c89530" stroke="none" />
        )}

        {/* Sauce */}
        {hasSauce && (
          <circle cx="55" cy="58" r="33" fill="#dc2626" stroke="#b91c1c" strokeWidth="0.5" opacity="0.9">
            <animate attributeName="r" from="0" to="33" dur="0.4s" fill="freeze" />
          </circle>
        )}

        {/* Cheese */}
        {hasCheese && (
          <g opacity="0.95">
            <circle cx="55" cy="58" r="32" fill="#fbbf24" stroke="#f59e0b" strokeWidth="0.3" />
            {/* Cheese texture — random-ish blobs */}
            <circle cx="45" cy="50" r="5" fill="#fcd34d" opacity="0.6" />
            <circle cx="65" cy="55" r="6" fill="#fcd34d" opacity="0.5" />
            <circle cx="55" cy="68" r="4" fill="#fcd34d" opacity="0.6" />
            <circle cx="50" cy="62" r="5" fill="#fde68a" opacity="0.4" />
            <circle cx="62" cy="48" r="4" fill="#fde68a" opacity="0.5" />
            <animate attributeName="opacity" from="0" to="0.95" dur="0.4s" fill="freeze" />
          </g>
        )}

        {/* Toppings */}
        {toppingsToRender}

        {/* Bake overlay — golden warmth */}
        {bakeOverlay}

        {/* Serve / Completion sparkle */}
        {(isComplete || hasServe) && (
          <g>
            <text x="55" y="15" textAnchor="middle" fontSize="14" className="animate-bounce">
              ✨
            </text>
          </g>
        )}
      </svg>
      <span className="text-[10px] text-zinc-500 text-center">
        {pizzaLayerLabel(done, total)}
      </span>
    </div>
  );
}
