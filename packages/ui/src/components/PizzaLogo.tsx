import * as React from "react";

interface PizzaLogoProps {
  className?: string;
}

// 6-slice SVG pizza pie.
// Visually distinct slices with thicker crust, cheese, and extra pepperoni.
const SLICE_COUNT = 6;
const SLICE_ANGLE = 360 / SLICE_COUNT; // 60°

// Hardcoded variations for pepperoni so each slice looks unique (not a kaleidoscope)
// Added more pepperoni per slice (4-5) for a "loaded" look.
const PEPPERONI_LOCATIONS = [
  // Slice 0
  [{ cx: 62, cy: 25, r: 3.5 }, { cx: 56, cy: 38, r: 3.5 }, { cx: 70, cy: 36, r: 2.5 }, { cx: 58, cy: 18, r: 2.8 }, { cx: 65, cy: 42, r: 3.0 }],
  // Slice 1
  [{ cx: 65, cy: 30, r: 3.5 }, { cx: 54, cy: 35, r: 3.5 }, { cx: 72, cy: 22, r: 2.5 }, { cx: 60, cy: 20, r: 3.0 }, { cx: 76, cy: 38, r: 2.8 }],
  // Slice 2
  [{ cx: 60, cy: 22, r: 3.5 }, { cx: 58, cy: 40, r: 3.5 }, { cx: 75, cy: 32, r: 2.5 }, { cx: 54, cy: 28, r: 3.0 }, { cx: 66, cy: 16, r: 2.8 }],
  // Slice 3
  [{ cx: 64, cy: 26, r: 3.5 }, { cx: 53, cy: 36, r: 3.5 }, { cx: 68, cy: 42, r: 2.5 }, { cx: 62, cy: 15, r: 2.8 }, { cx: 74, cy: 30, r: 3.0 }],
  // Slice 4
  [{ cx: 66, cy: 32, r: 3.5 }, { cx: 55, cy: 28, r: 3.5 }, { cx: 72, cy: 40, r: 2.5 }, { cx: 58, cy: 18, r: 3.0 }, { cx: 64, cy: 42, r: 2.8 }],
  // Slice 5
  [{ cx: 61, cy: 24, r: 3.5 }, { cx: 57, cy: 38, r: 3.5 }, { cx: 74, cy: 28, r: 2.5 }, { cx: 55, cy: 15, r: 2.8 }, { cx: 68, cy: 18, r: 3.0 }],
];

export function PizzaLogo({ className = "" }: PizzaLogoProps) {
  const [hoveredSlices, setHoveredSlices] = React.useState<Set<number>>(new Set());
  const [isHovering, setIsHovering] = React.useState(false);

  const handleMouseEnter = () => setIsHovering(true);

  const handleMouseLeave = () => {
    setIsHovering(false);
    setHoveredSlices(new Set());
  };

  const handleSliceMouseEnter = (sliceId: number) => {
    if (!isHovering) return;
    setHoveredSlices((prev) => {
      const next = new Set(prev);
      next.add(sliceId);
      return next;
    });
  };

  // Auto-remove slices animation
  React.useEffect(() => {
    if (!isHovering || hoveredSlices.size >= SLICE_COUNT) return;

    const timer = setTimeout(() => {
      for (let i = 0; i < SLICE_COUNT; i++) {
        if (!hoveredSlices.has(i)) {
          setHoveredSlices((prev) => new Set(prev).add(i));
          break;
        }
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [isHovering, hoveredSlices]);

  const slices = Array.from({ length: SLICE_COUNT }, (_, i) => i);

  return (
    <div
      className={`relative inline-flex items-center justify-center cursor-pointer ${className}`}
      style={{ width: 56, height: 56 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <svg
        viewBox="0 0 100 100"
        aria-hidden="true"
        className="block h-full w-full"
        style={{ filter: "drop-shadow(0px 2px 2px rgba(0,0,0,0.1))" }}
      >
        <defs>
          <filter id="burnt-cheese" x="0%" y="0%" width="100%" height="100%">
            {/* Generate noise for the speckles */}
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" result="noise" />
            
            {/* Threshold the noise to create isolated spots (high contrast) */}
            <feColorMatrix 
              type="matrix" 
              values="0 0 0 0 0
                      0 0 0 0 0
                      0 0 0 0 0
                      0 0 0 18 -10" 
              in="noise" 
              result="speckles-alpha" 
            />

            {/* Tint the speckles a brownish burnt color */}
            <feFlood floodColor="#92400e" floodOpacity="0.5" result="brown-flood" />
            <feComposite operator="in" in="brown-flood" in2="speckles-alpha" result="colored-speckles" />
            
            {/* Overlay the speckles onto the cheese */}
            <feComposite operator="over" in="colored-speckles" in2="SourceGraphic" />
          </filter>
        </defs>

        {/* Rotate the whole pie -30deg so the first slice is centered at the top */}
        <g transform="rotate(-30 50 50)">
          {slices.map((index) => {
            const rotation = index * SLICE_ANGLE;
            const isEaten = hoveredSlices.has(index);
            const peps = PEPPERONI_LOCATIONS[index % PEPPERONI_LOCATIONS.length];

            return (
              // Outer group handles Position/Rotation
              <g key={index} transform={`rotate(${rotation} 50 50)`}>
                {/* Inner group handles Scale Animation & Events */}
                <g
                  style={{
                    transformOrigin: "50px 50px",
                    transition: "opacity 0.2s ease, transform 0.2s ease",
                    opacity: isEaten ? 0 : 1,
                    transform: isEaten ? "scale(0.8)" : "scale(1)",
                  }}
                  onMouseEnter={() => handleSliceMouseEnter(index)}
                >
                  {/* Wedge Path (Crust) - r=48 */}
                  <path
                    d="M 50 50 L 50 2 A 48 48 0 0 1 91.6 26 Z"
                    fill="#b45309" // Darker, more apparent crust (Amber 700)
                    stroke="#78350f" // Dark cut line
                    strokeWidth="1"
                  />
                  {/* Inner cheese - r=41 (leaves 7 units for crust) */}
                  <path
                    d="M 50 50 L 50 9 A 41 41 0 0 1 85.5 29.5 Z"
                    fill="#fcd34d" // Cheese
                    filter="url(#burnt-cheese)"
                  />
                  
                  {/* Randomized Pepperoni */}
                  {peps.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.cx}
                      cy={p.cy}
                      r={p.r}
                      fill="#ef4444"
                      opacity="0.9"
                    />
                  ))}
                </g>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
