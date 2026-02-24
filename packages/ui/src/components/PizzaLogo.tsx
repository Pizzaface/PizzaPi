import * as React from "react";

interface PizzaLogoProps {
  className?: string;
}

const SLICE_COUNT = 8;
const CX = 300;
const CY = 340;
const CLIP_R = 300;
const SEP = 15; // px separation on hover

// Pre-compute wedge geometry
const sliceData = Array.from({ length: SLICE_COUNT }, (_, i) => {
  const a0 = ((i * 45 - 90) * Math.PI) / 180;
  const a1 = (((i + 1) * 45 - 90) * Math.PI) / 180;
  const mid = ((i * 45 - 90 + 22.5) * Math.PI) / 180;
  const x0 = CX + CLIP_R * Math.cos(a0);
  const y0 = CY + CLIP_R * Math.sin(a0);
  const x1 = CX + CLIP_R * Math.cos(a1);
  const y1 = CY + CLIP_R * Math.sin(a1);
  return {
    clipPath: `M ${CX} ${CY} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${CLIP_R} ${CLIP_R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`,
    dx: Math.cos(mid),
    dy: Math.sin(mid),
  };
});

export function PizzaLogo({ className = "" }: PizzaLogoProps) {
  const id = React.useId().replace(/:/g, "");
  const [hoveredSlices, setHoveredSlices] = React.useState<Set<number>>(new Set());
  const [isHovering, setIsHovering] = React.useState(false);

  const handleMouseEnter = () => setIsHovering(true);
  const handleMouseLeave = () => {
    setIsHovering(false);
    setHoveredSlices(new Set());
  };
  const handleSliceMouseEnter = (idx: number) => {
    if (!isHovering) return;
    setHoveredSlices((prev) => new Set(prev).add(idx));
  };

  // Auto-eat remaining slices
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

  return (
    <div
      className={`relative inline-flex items-center justify-center cursor-pointer w-9 h-9 sm:w-14 sm:h-14 ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <svg
        viewBox="30 70 540 540"
        aria-hidden="true"
        className="block h-full w-full"
        style={{ filter: "drop-shadow(0px 2px 3px rgba(0,0,0,0.2))" }}
      >
        <defs>
          {/* Filters */}
          <filter id={`${id}-ts`} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="1.5" dy="2.5" stdDeviation="1.5" floodOpacity="0.5" floodColor="#000" />
          </filter>

          {/* Topping definitions */}
          <g id={`${id}-pepperoni`} filter={`url(#${id}-ts)`}>
            <circle cx="0" cy="0" r="25" fill="#d13838" stroke="#a82222" strokeWidth="2" />
            <circle cx="-10" cy="-8" r="2.5" fill="#8c1616" />
            <circle cx="12" cy="-4" r="3" fill="#8c1616" />
            <circle cx="-2" cy="12" r="2" fill="#8c1616" />
            <circle cx="8" cy="10" r="2.5" fill="#8c1616" />
            <circle cx="-12" cy="8" r="1.5" fill="#8c1616" />
            <circle cx="4" cy="-12" r="2" fill="#8c1616" />
            <path d="M -15 -15 Q 0 -22 15 -15" fill="none" stroke="#e86161" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
          </g>

          <g id={`${id}-mushroom`} filter={`url(#${id}-ts)`}>
            <path d="M -14 0 C -14 -12 14 -12 14 0 C 14 4 10 7 4 7 L 4 15 C 4 18 -4 18 -4 15 L -4 7 C -10 7 -14 4 -14 0 Z" fill="#e3dacc" stroke="#bdae97" strokeWidth="1.5" />
            <path d="M -8 -2 C -8 -6 -2 -8 0 -8" fill="none" stroke="#bdae97" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M 4 -2 C 4 -5 2 -7 0 -7" fill="none" stroke="#bdae97" strokeWidth="1.5" strokeLinecap="round" />
          </g>

          <g id={`${id}-olive`} filter={`url(#${id}-ts)`}>
            <circle cx="0" cy="0" r="8" fill="#141414" stroke="#2b2b2b" strokeWidth="3" />
            <circle cx="-3.5" cy="-3.5" r="1.5" fill="#5c5c5c" />
          </g>

          <g id={`${id}-pepper`} filter={`url(#${id}-ts)`}>
            <path d="M -15 -5 Q -8 -15 0 -10 Q 8 -15 15 -5 Q 10 10 0 15 Q -10 10 -15 -5 Z" fill="none" stroke="#388e3c" strokeWidth="4.5" strokeLinejoin="round" />
            <path d="M -15 -5 Q -8 -15 0 -10 Q 8 -15 15 -5 Q 10 10 0 15 Q -10 10 -15 -5 Z" fill="none" stroke="#66bb6a" strokeWidth="1.5" strokeLinejoin="round" opacity="0.8" />
          </g>

          <g id={`${id}-basil`} filter={`url(#${id}-ts)`}>
            <path d="M 0 -18 C 12 -18 18 -6 18 0 C 18 12 0 18 0 18 C 0 18 -18 12 -18 0 C -18 -6 -12 -18 0 -18 Z" fill="#2e7d32" stroke="#1b5e20" strokeWidth="1" />
            <path d="M 0 -16 L 0 16" fill="none" stroke="#1b5e20" strokeWidth="1.5" />
            <path d="M 0 0 Q 6 -4 10 -2 M 0 6 Q -6 2 -10 4 M 0 -8 Q -6 -12 -10 -10" fill="none" stroke="#1b5e20" strokeWidth="1" />
          </g>

          <g id={`${id}-burn`}>
            <ellipse cx="0" cy="0" rx="16" ry="6" fill="#a6581c" opacity="0.3" />
            <ellipse cx="2" cy="1" rx="8" ry="3" fill="#803e0b" opacity="0.4" />
          </g>

          {/* Full pizza content (referenced per slice) */}
          <g id={`${id}-pizza`}>
            {/* Crust */}
            <circle cx="300" cy="340" r="250" fill="#edb574" />
            <circle cx="300" cy="340" r="236" fill="none" stroke="#d99c52" strokeWidth="12" />
            <circle cx="300" cy="340" r="248" fill="none" stroke="#fce4c5" strokeWidth="3" opacity="0.5" />

            {/* Crust burns */}
            <use href={`#${id}-burn`} transform="translate(300, 105)" />
            <use href={`#${id}-burn`} transform="translate(465, 175) rotate(45)" />
            <use href={`#${id}-burn`} transform="translate(535, 340) rotate(90)" />
            <use href={`#${id}-burn`} transform="translate(465, 505) rotate(135)" />
            <use href={`#${id}-burn`} transform="translate(300, 575) rotate(180)" />
            <use href={`#${id}-burn`} transform="translate(135, 505) rotate(225)" />
            <use href={`#${id}-burn`} transform="translate(65, 340) rotate(270)" />
            <use href={`#${id}-burn`} transform="translate(135, 175) rotate(315)" />
            <use href={`#${id}-burn`} transform="translate(200, 120) rotate(25)" />
            <use href={`#${id}-burn`} transform="translate(515, 250) rotate(65)" />

            {/* Sauce */}
            <circle cx="300" cy="340" r="225" fill="#cc3721" />
            <circle cx="300" cy="340" r="218" fill="none" stroke="#a3200e" strokeWidth="5" opacity="0.5" />

            {/* Cheese */}
            <circle cx="300" cy="340" r="215" fill="#f7d54d" />
            <circle cx="200" cy="250" r="45" fill="#fae178" />
            <circle cx="380" cy="260" r="50" fill="#fae178" />
            <circle cx="260" cy="450" r="60" fill="#fae178" />
            <circle cx="340" cy="180" r="40" fill="#fae178" />
            <circle cx="430" cy="360" r="35" fill="#fae178" />
            <circle cx="410" cy="410" r="40" fill="#eebb2a" />
            <circle cx="280" cy="200" r="45" fill="#eebb2a" />
            <circle cx="180" cy="380" r="35" fill="#eebb2a" />
            <circle cx="280" cy="330" r="45" fill="#eebb2a" />

            {/* Oregano */}
            <g fill="#4e5c27" opacity="0.6">
              <circle cx="300" cy="340" r="1.5" /><circle cx="290" cy="350" r="1" /><circle cx="310" cy="360" r="2" /><circle cx="305" cy="325" r="1.5" />
              <circle cx="210" cy="220" r="1.5" /><circle cx="215" cy="225" r="1" /><circle cx="225" cy="215" r="2" /><circle cx="190" cy="240" r="1.5" />
              <circle cx="350" cy="200" r="1.5" /><circle cx="360" cy="190" r="1" /><circle cx="380" cy="210" r="2" /><circle cx="390" cy="190" r="1" />
              <circle cx="400" cy="350" r="1.5" /><circle cx="410" cy="360" r="1.5" /><circle cx="430" cy="340" r="1" /><circle cx="420" cy="380" r="2" />
              <circle cx="180" cy="320" r="1.5" /><circle cx="190" cy="330" r="1" /><circle cx="170" cy="350" r="2" /><circle cx="200" cy="370" r="1.5" />
              <circle cx="280" cy="160" r="1.5" /><circle cx="320" cy="150" r="1" />
              <circle cx="290" cy="510" r="1.5" /><circle cx="330" cy="500" r="2" />
            </g>

            {/* Toppings (shifted down slightly) */}
            <g transform="translate(0, 30)">

            {/* Pepperonis */}
            <use href={`#${id}-pepperoni`} transform="translate(300, 340)" />
            <use href={`#${id}-pepperoni`} transform="translate(220, 260)" />
            <use href={`#${id}-pepperoni`} transform="translate(380, 250)" />
            <use href={`#${id}-pepperoni`} transform="translate(250, 180)" />
            <use href={`#${id}-pepperoni`} transform="translate(360, 170)" />
            <use href={`#${id}-pepperoni`} transform="translate(160, 320)" />
            <use href={`#${id}-pepperoni`} transform="translate(440, 330)" />
            <use href={`#${id}-pepperoni`} transform="translate(200, 420)" />
            <use href={`#${id}-pepperoni`} transform="translate(300, 450)" />
            <use href={`#${id}-pepperoni`} transform="translate(400, 420)" />
            <use href={`#${id}-pepperoni`} transform="translate(260, 300)" />
            <use href={`#${id}-pepperoni`} transform="translate(340, 380)" />

            {/* Mushrooms */}
            <use href={`#${id}-mushroom`} transform="translate(280, 210) rotate(20)" />
            <use href={`#${id}-mushroom`} transform="translate(330, 290) rotate(-45)" />
            <use href={`#${id}-mushroom`} transform="translate(210, 340) rotate(80)" />
            <use href={`#${id}-mushroom`} transform="translate(380, 350) rotate(-10)" />
            <use href={`#${id}-mushroom`} transform="translate(270, 400) rotate(110)" />
            <use href={`#${id}-mushroom`} transform="translate(180, 270) rotate(-70)" />
            <use href={`#${id}-mushroom`} transform="translate(410, 280) rotate(45)" />
            <use href={`#${id}-mushroom`} transform="translate(330, 470) rotate(15)" />
            <use href={`#${id}-mushroom`} transform="translate(240, 480) rotate(-30)" />
            <use href={`#${id}-mushroom`} transform="translate(460, 400) rotate(60)" />

            {/* Olives */}
            <use href={`#${id}-olive`} transform="translate(310, 170)" />
            <use href={`#${id}-olive`} transform="translate(250, 230)" />
            <use href={`#${id}-olive`} transform="translate(360, 210)" />
            <use href={`#${id}-olive`} transform="translate(180, 370)" />
            <use href={`#${id}-olive`} transform="translate(420, 380)" />
            <use href={`#${id}-olive`} transform="translate(230, 380)" />
            <use href={`#${id}-olive`} transform="translate(310, 410)" />
            <use href={`#${id}-olive`} transform="translate(370, 460)" />
            <use href={`#${id}-olive`} transform="translate(200, 300)" />
            <use href={`#${id}-olive`} transform="translate(430, 230)" />
            <use href={`#${id}-olive`} transform="translate(280, 270)" />
            <use href={`#${id}-olive`} transform="translate(360, 310)" />
            <use href={`#${id}-olive`} transform="translate(260, 470)" />
            <use href={`#${id}-olive`} transform="translate(130, 270)" />

            {/* Green Peppers */}
            <use href={`#${id}-pepper`} transform="translate(240, 200) rotate(35)" />
            <use href={`#${id}-pepper`} transform="translate(390, 210) rotate(-25)" />
            <use href={`#${id}-pepper`} transform="translate(190, 240) rotate(115)" />
            <use href={`#${id}-pepper`} transform="translate(440, 290) rotate(85)" />
            <use href={`#${id}-pepper`} transform="translate(230, 450) rotate(-65)" />
            <use href={`#${id}-pepper`} transform="translate(380, 410) rotate(45)" />
            <use href={`#${id}-pepper`} transform="translate(300, 270) rotate(15)" />
            <use href={`#${id}-pepper`} transform="translate(170, 420) rotate(-15)" />
            <use href={`#${id}-pepper`} transform="translate(310, 490) rotate(70)" />

            {/* Basil */}
            <use href={`#${id}-basil`} transform="translate(300, 340) rotate(15)" />
            <use href={`#${id}-basil`} transform="translate(250, 260) rotate(-45)" />
            <use href={`#${id}-basil`} transform="translate(370, 280) rotate(60)" />
            <use href={`#${id}-basil`} transform="translate(280, 430) rotate(-80)" />
            <use href={`#${id}-basil`} transform="translate(400, 370) rotate(110)" />
            <use href={`#${id}-basil`} transform="translate(200, 180) rotate(30)" />

            </g>{/* end toppings offset */}
          </g>

          {/* Clip paths for each slice */}
          {sliceData.map((s, i) => (
            <clipPath key={i} id={`${id}-clip-${i}`}>
              <path d={s.clipPath} />
            </clipPath>
          ))}
        </defs>

        {/* Render 8 slices, each clipping the full pizza */}
        {sliceData.map((s, i) => {
          const isEaten = hoveredSlices.has(i);
          const tx = isEaten ? s.dx * SEP : 0;
          const ty = isEaten ? s.dy * SEP : 0;
          return (
            <g
              key={i}
              clipPath={`url(#${id}-clip-${i})`}
              style={{
                transition: "opacity 0.25s ease, transform 0.25s ease",
                opacity: isEaten ? 0 : 1,
                transform: `translate(${tx}px, ${ty}px)${isEaten ? " scale(0.92)" : ""}`,
                transformOrigin: `${CX}px ${CY}px`,
              }}
              onMouseEnter={() => handleSliceMouseEnter(i)}
            >
              <use href={`#${id}-pizza`} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
