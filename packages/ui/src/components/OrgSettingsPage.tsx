import * as React from "react";
import {
  Building2,
  Users,
  HardDrive,
  UserPlus,
  Trash2,
  RefreshCw,
  AlertCircle,
  Mail,
  Shield,
  Crown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import {
  getOrg,
  listOrgMembers,
  listOrgRunners,
  inviteOrgMember,
  removeOrgMember,
  type Org,
  type OrgMember,
  type OrgRunner,
} from "@/lib/control-plane";

const ROLE_ICON: Record<string, React.ReactNode> = {
  owner: <Crown className="h-3.5 w-3.5 text-amber-500" />,
  admin: <Shield className="h-3.5 w-3.5 text-blue-500" />,
  member: <Users className="h-3.5 w-3.5 text-muted-foreground" />,
};

/**
 * Org settings page — view org info, manage members, view runners.
 */
export function OrgSettingsPage({ onClose }: { onClose: () => void }) {
  const slug = React.useMemo(() => {
    const parts = window.location.hostname.split(".");
    return parts.length >= 3 ? parts[0] : null;
  }, []);

  const [org, setOrg] = React.useState<Org | null>(null);
  const [members, setMembers] = React.useState<OrgMember[]>([]);
  const [runners, setRunners] = React.useState<OrgRunner[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState("member");
  const [inviting, setInviting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);

  const fetchAll = React.useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const [orgData, membersData, runnersData] = await Promise.all([
        getOrg(slug),
        listOrgMembers(slug),
        listOrgRunners(slug),
      ]);
      setOrg(orgData);
      setMembers(membersData);
      setRunners(runnersData);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  React.useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!slug || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      await inviteOrgMember(slug, inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      setInviteRole("member");
      await fetchAll();
    } catch (err) {
      setInviteError(String(err));
    } finally {
      setInviting(false);
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!slug) return;
    try {
      await removeOrgMember(slug, memberId);
      await fetchAll();
    } catch (err) {
      setError(String(err));
    }
  }

  if (!slug) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-center">
        <p className="text-muted-foreground">Org settings are only available on an org subdomain.</p>
        <Button variant="outline" className="mt-4" onClick={onClose}>Go back</Button>
      </div>
    );
  }

  if (loading && !org) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (error && !org) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span>{error}</span>
        </div>
        <Button variant="outline" className="mt-4" onClick={onClose}>Go back</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            {org?.name}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            <span className="font-mono">{org?.slug}</span>
            {org?.plan && (
              <>
                {" · "}
                <Badge variant="secondary">{org.plan}</Badge>
              </>
            )}
            {org?.createdAt && (
              <>
                {" · Created "}
                {new Date(org.createdAt).toLocaleDateString()}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchAll} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members" className="gap-1.5">
            <Users className="h-4 w-4" />
            Members ({members.length})
          </TabsTrigger>
          <TabsTrigger value="runners" className="gap-1.5">
            <HardDrive className="h-4 w-4" />
            Runners ({runners.length})
          </TabsTrigger>
        </TabsList>

        {/* Members tab */}
        <TabsContent value="members" className="space-y-4 mt-4">
          {/* Invite form */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Invite Member</CardTitle>
              <CardDescription>Add a user to this organization by email.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleInvite} className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="user@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="w-32 space-y-1.5">
                  <Label htmlFor="invite-role">Role</Label>
                  <Select value={inviteRole} onValueChange={setInviteRole}>
                    <SelectTrigger id="invite-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={inviting} className="gap-2">
                  {inviting ? <Spinner className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
                  Invite
                </Button>
              </form>
              {inviteError && (
                <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {inviteError}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Members table */}
          <Card>
            <CardContent className="pt-6">
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No members yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Joined</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className="font-medium">{member.name}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <Mail className="h-3.5 w-3.5" />
                            {member.email}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {ROLE_ICON[member.role]}
                            <span className="capitalize">{member.role}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(member.joinedAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {member.role !== "owner" && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Remove {member.name}?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will remove {member.name} from the organization. They can be re-invited later.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-white hover:bg-destructive/90"
                                    onClick={() => handleRemoveMember(member.id)}
                                  >
                                    Remove
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Runners tab */}
        <TabsContent value="runners" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {runners.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No runners connected to this organization.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last Seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runners.map((runner) => (
                      <TableRow key={runner.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <HardDrive className="h-4 w-4 text-muted-foreground" />
                            {runner.name}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={runner.status === "online" ? "default" : "secondary"}>
                            <span
                              className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                                runner.status === "online" ? "bg-green-500" : "bg-gray-400"
                              }`}
                            />
                            {runner.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(runner.lastSeen).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
