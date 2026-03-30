import * as React from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Check, X } from "lucide-react";
import { validatePassword, type PasswordCheck } from "@pizzapi/protocol";
import { authClient } from "@/lib/auth-client";

interface ChangePasswordDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
    const [currentPassword, setCurrentPassword] = React.useState("");
    const [newPassword, setNewPassword] = React.useState("");
    const [confirmPassword, setConfirmPassword] = React.useState("");
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [success, setSuccess] = React.useState(false);

    // Live validation for new password
    const passwordCheck: PasswordCheck | null =
        newPassword.length > 0 ? validatePassword(newPassword) : null;

    const passwordsMatch = newPassword === confirmPassword;
    const canSubmit =
        !loading &&
        currentPassword.length > 0 &&
        newPassword.length > 0 &&
        confirmPassword.length > 0 &&
        (passwordCheck?.valid ?? false) &&
        passwordsMatch;

    function reset() {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setError(null);
        setSuccess(false);
        setLoading(false);
    }

    function handleOpenChange(next: boolean) {
        if (!next) reset();
        onOpenChange(next);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!canSubmit) return;

        setError(null);
        setLoading(true);

        try {
            const { error: apiError } = await authClient.changePassword({
                currentPassword,
                newPassword,
                revokeOtherSessions: true,
            });

            if (apiError) {
                setError(apiError.message ?? "Failed to change password");
                return;
            }

            setSuccess(true);
            // Auto-close after a brief delay so the user sees the success message.
            setTimeout(() => handleOpenChange(false), 1500);
        } catch (err) {
            setError(err instanceof Error ? err.message : "An unexpected error occurred");
        } finally {
            setLoading(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Change password</DialogTitle>
                    <DialogDescription>
                        Enter your current password and choose a new one.
                    </DialogDescription>
                </DialogHeader>

                {success ? (
                    <div className="flex items-center gap-2 py-4 text-green-600 dark:text-green-400">
                        <Check className="h-5 w-5" />
                        <span className="text-sm font-medium">Password changed successfully.</span>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit}>
                        <div className="flex flex-col gap-4 py-2">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="cp-current">Current password</Label>
                                <Input
                                    id="cp-current"
                                    type="password"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                    required
                                    autoComplete="current-password"
                                    autoFocus
                                />
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="cp-new">New password</Label>
                                <Input
                                    id="cp-new"
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    required
                                    autoComplete="new-password"
                                />
                                {passwordCheck && (
                                    <ul className="flex flex-col gap-0.5 mt-1">
                                        {passwordCheck.checks.map((c) => (
                                            <li
                                                key={c.label}
                                                className={`flex items-center gap-1.5 text-xs ${c.met ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                                            >
                                                {c.met ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                                                {c.label}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="cp-confirm">Confirm new password</Label>
                                <Input
                                    id="cp-confirm"
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    required
                                    autoComplete="new-password"
                                />
                                {confirmPassword.length > 0 && !passwordsMatch && (
                                    <p className="text-xs text-destructive mt-0.5">Passwords do not match</p>
                                )}
                            </div>

                            {error && <p className="text-sm text-destructive">{error}</p>}
                        </div>

                        <DialogFooter className="mt-4">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => handleOpenChange(false)}
                                disabled={loading}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!canSubmit}>
                                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {loading ? "Changing…" : "Change password"}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
