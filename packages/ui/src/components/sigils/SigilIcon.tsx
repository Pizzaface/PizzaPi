/**
 * SigilIcon — renders a Lucide icon by string name.
 *
 * Any lucide icon name works (lazy-loaded on demand). Unknown names fall
 * back to HashIcon.
 */
import type { ComponentProps } from "react";
import { HashIcon } from "lucide-react";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";

type IconProps = ComponentProps<typeof HashIcon>;

export function SigilIcon({ name, ...props }: IconProps & { name: string }) {
  return <DynamicLucideIcon name={name} fallback={HashIcon} {...props} />;
}
