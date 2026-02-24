import * as React from "react";
import { Building2, Trash2, Plus, RefreshCw, Users, HardDrive, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { listOrgs, createOrg, deleteOrg, type Org } from "@/lib/control-plane";

/**
 * Admin page — list all orgs, create/delete orgs, show health.
 * Only rendered on the control plane domain.
 */
export function AdminPage({ onClose }: { onClose: () => void }) {
  const [orgs, setOrgs] = React.useState<Org[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Create form
  const [newName, setNewName] = React.useState("");
  const [newSlug, setNewSlug] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  const fetchOrgs = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOrgs(await listOrgs());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newSlug.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createOrg({ name: newName.trim(), slug: newSlug.trim().toLowerCase() });
      setNewName("");
      setNewSlug("");
      await fetchOrgs();
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteOrg(id);
      await fetchOrgs();
    } catch (err) {
      setError(String(err));
    }
  }

  // Auto-generate slug from name
  function handleNameChange(value: string) {
    setNewName(value);
    setNewSlug(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin — Organizations</h1>
          <p className="text-sm text-muted-foreground">Manage all organizations on this PizzaPi instance.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchOrgs} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {/* Create org form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Create Organization</CardTitle>
          <CardDescription>Add a new organization to this PizzaPi instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                placeholder="Acme Corp"
                value={newName}
                onChange={(e) => handleNameChange(e.target.value)}
                required
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="org-slug">Slug</Label>
              <Input
                id="org-slug"
                placeholder="acme-corp"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                pattern="[a-z0-9-]+"
                required
              />
            </div>
            <Button type="submit" disabled={creating} className="gap-2">
              {creating ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              Create
            </Button>
          </form>
          {createError && (
            <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {createError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Org list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Organizations</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && orgs.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-sm text-destructive py-4">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          ) : orgs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No organizations yet. Create one above.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-center">Members</TableHead>
                    <TableHead className="text-center">Runners</TableHead>
                    <TableHead className="text-center">Health</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orgs.map((org) => (
                    <TableRow key={org.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          {org.name}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">{org.slug}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{org.plan}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Users className="h-3.5 w-3.5 text-muted-foreground" />
                          {org.memberCount ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                          {org.runnerCount ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <span
                          className={`inline-block h-2.5 w-2.5 rounded-full ${
                            org.healthy === true
                              ? "bg-green-500"
                              : org.healthy === false
                                ? "bg-red-500"
                                : "bg-yellow-500"
                          }`}
                          title={
                            org.healthy === true
                              ? "Healthy"
                              : org.healthy === false
                                ? "Unhealthy"
                                : "Unknown"
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete &ldquo;{org.name}&rdquo;?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete the organization, all its members, runners, and data. This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-white hover:bg-destructive/90"
                                onClick={() => handleDelete(org.id)}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
