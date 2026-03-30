/**
 * SigilIcon — renders a Lucide icon by string name.
 *
 * Uses a static map of icons commonly used by sigil types. Service-provided
 * icon names that aren't in the map fall back to HashIcon.
 *
 * To add support for more icons, just add them to ICON_MAP — they're
 * tree-shaken by Vite so only imported icons ship in the bundle.
 */
import type { ComponentProps } from "react";
import {
  FileIcon,
  GitPullRequestIcon,
  CircleDotIcon,
  GitCommitHorizontalIcon,
  GitBranchIcon,
  BookMarkedIcon,
  CheckCircleIcon,
  CircleIcon,
  AlertTriangleIcon,
  DollarSignIcon,
  ClockIcon,
  TerminalIcon,
  BrainIcon,
  TerminalSquareIcon,
  TagIcon,
  FlaskConicalIcon,
  ExternalLinkIcon,
  DiffIcon,
  HashIcon,
  GithubIcon,
  PackageIcon,
  ShieldIcon,
  ZapIcon,
  DatabaseIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  UserIcon,
  FolderIcon,
  SettingsIcon,
  ServerIcon,
  ActivityIcon,
  BellIcon,
  MessageSquareIcon,
} from "lucide-react";

type IconProps = ComponentProps<typeof HashIcon>;

const ICON_MAP: Record<string, React.ComponentType<IconProps>> = {
  // Core sigil icons
  file: FileIcon,
  "git-pull-request": GitPullRequestIcon,
  "circle-dot": CircleDotIcon,
  "git-commit-horizontal": GitCommitHorizontalIcon,
  "git-branch": GitBranchIcon,
  "book-marked": BookMarkedIcon,
  "check-circle": CheckCircleIcon,
  circle: CircleIcon,
  "alert-triangle": AlertTriangleIcon,
  "dollar-sign": DollarSignIcon,
  clock: ClockIcon,
  terminal: TerminalIcon,
  brain: BrainIcon,
  "terminal-square": TerminalSquareIcon,
  tag: TagIcon,
  "flask-conical": FlaskConicalIcon,
  "external-link": ExternalLinkIcon,
  diff: DiffIcon,
  hash: HashIcon,
  // Extended icons for service-provided sigils
  github: GithubIcon,
  package: PackageIcon,
  shield: ShieldIcon,
  zap: ZapIcon,
  database: DatabaseIcon,
  globe: GlobeIcon,
  key: KeyIcon,
  lock: LockIcon,
  user: UserIcon,
  folder: FolderIcon,
  settings: SettingsIcon,
  server: ServerIcon,
  activity: ActivityIcon,
  bell: BellIcon,
  "message-square": MessageSquareIcon,
};

export function SigilIcon({ name, ...props }: IconProps & { name: string }) {
  const Icon = ICON_MAP[name] ?? HashIcon;
  return <Icon {...props} />;
}
