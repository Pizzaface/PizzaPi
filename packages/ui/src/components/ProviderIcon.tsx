import { cn } from "@/lib/utils";

import { RiClaudeFill, RiRobot2Fill } from "react-icons/ri";
import { SiAmazon, SiGithub, SiGoogle, SiNvidia, SiOllama, SiOpenai } from "react-icons/si";

export interface ProviderIconProps {
  provider: string;
  className?: string;
  title?: string;
}

function pickIcon(provider: string) {
  const p = provider.toLowerCase();

  // Common providers we support in PizzaPi
  if (p.includes("anthropic") || p.includes("claude")) return RiClaudeFill;
  if (p.includes("openai")) return SiOpenai;
  if (p.includes("ollama")) return SiOllama;
  if (p.startsWith("google")) return SiGoogle;
  if (p.includes("github")) return SiGithub;
  if (p.includes("amazon") || p.includes("bedrock")) return SiAmazon;
  if (p.includes("nvidia")) return SiNvidia;

  return RiRobot2Fill;
}

export function ProviderIcon({ provider, className, title }: ProviderIconProps) {
  const Icon = pickIcon(provider);
  const accessibilityProps = title
    ? { title, "aria-label": title, role: "img" as const }
    : { "aria-hidden": true as const };

  return (
    <Icon
      className={cn("shrink-0", className)}
      {...accessibilityProps}
    />
  );
}
