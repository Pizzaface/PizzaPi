import * as React from "react";
import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listMyOrgs, type Org } from "@/lib/control-plane";

/**
 * Org switcher dropdown for the app header.
 * Shows user's orgs, highlights the current one, and navigates on select.
 */
export function OrgSwitcher() {
  const [orgs, setOrgs] = React.useState<Org[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const currentSlug = React.useMemo(() => {
    const host = window.location.hostname;
    const parts = host.split(".");
    // e.g. acme.pizzapi.example.com → slug = "acme"
    return parts.length >= 3 ? parts[0] : null;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listMyOrgs()
      .then((data) => { if (!cancelled) setOrgs(data); })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const currentOrg = orgs.find((o) => o.slug === currentSlug);

  function navigateToOrg(org: Org) {
    if (org.slug === currentSlug) return;
    const { protocol, port, pathname } = window.location;
    const host = window.location.hostname;
    const baseDomain = host.split(".").slice(currentSlug ? 1 : 0).join(".");
    const newHost = `${org.slug}.${baseDomain}`;
    const portSuffix = port && port !== "443" && port !== "80" ? `:${port}` : "";
    window.location.href = `${protocol}//${newHost}${portSuffix}${pathname}`;
  }

  if (loading) {
    return <Skeleton className="h-9 w-32" />;
  }

  if (error || orgs.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 max-w-48">
          <Building2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="truncate">{currentOrg?.name ?? "Select org"}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onSelect={() => navigateToOrg(org)}
            className="gap-2"
          >
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 truncate">{org.name}</span>
            {org.slug === currentSlug && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            const base = window.location.origin;
            window.location.href = `${base}/admin`;
          }}
          className="gap-2 text-muted-foreground"
        >
          <Plus className="h-4 w-4" />
          Create organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
