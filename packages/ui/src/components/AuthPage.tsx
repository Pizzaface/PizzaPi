import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { PizzaLogo } from "@/components/PizzaLogo";
import { signIn, signUp } from "@/lib/auth-client";
import { Loader2 } from "lucide-react";

interface AuthPageProps {
    onAuthenticated: () => void;
}

type Tab = "signin" | "signup";

export function AuthPage({ onAuthenticated }: AuthPageProps) {
    const [tab, setTab] = React.useState<Tab>("signin");
    const [name, setName] = React.useState("");
    const [email, setEmail] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    const signinRef = React.useRef<HTMLButtonElement>(null);
    const signupRef = React.useRef<HTMLButtonElement>(null);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            if (tab === "signin") {
                const { error } = await signIn.email({ email, password });
                if (error) {
                    setError(error.message ?? "Sign in failed");
                    return;
                }
            } else {
                const { error } = await signUp.email({ name, email, password });
                if (error) {
                    setError(error.message ?? "Sign up failed");
                    return;
                }
            }
            onAuthenticated();
        } catch (err) {
            setError(err instanceof Error ? err.message : "An unexpected error occurred");
        } finally {
            setLoading(false);
        }
    }

    function switchTab(next: Tab) {
        setTab(next);
        setError(null);
    }

    function handleKeyDown(e: React.KeyboardEvent) {
        if (e.key === "ArrowRight") {
            e.preventDefault();
            switchTab("signup");
            signupRef.current?.focus();
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            switchTab("signin");
            signinRef.current?.focus();
        } else if (e.key === "Home") {
            e.preventDefault();
            switchTab("signin");
            signinRef.current?.focus();
        } else if (e.key === "End") {
            e.preventDefault();
            switchTab("signup");
            signupRef.current?.focus();
        }
    }

    return (
        <div className="flex min-h-[100dvh] w-full items-start justify-center bg-background p-4 overflow-y-auto pp-safe-top pp-safe-bottom sm:items-center">
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <div className="flex justify-center">
                        <PizzaLogo />
                    </div>
                    <CardTitle className="text-xl text-center">PizzaPi</CardTitle>
                    <CardDescription>
                        {tab === "signin" ? "Sign in to your account." : "Create a new account."}
                    </CardDescription>
                    {/* Tabs */}
                    <div
                        role="tablist"
                        aria-label="Authentication Options"
                        className="flex gap-1 mt-2 border-b"
                        onKeyDown={handleKeyDown}
                    >
                        <button
                            ref={signinRef}
                            id="tab-signin"
                            role="tab"
                            aria-selected={tab === "signin"}
                            aria-controls="auth-panel"
                            tabIndex={tab === "signin" ? 0 : -1}
                            type="button"
                            className={`px-3 py-1.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === "signin" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                            onClick={() => switchTab("signin")}
                        >
                            Sign in
                        </button>
                        <button
                            ref={signupRef}
                            id="tab-signup"
                            role="tab"
                            aria-selected={tab === "signup"}
                            aria-controls="auth-panel"
                            tabIndex={tab === "signup" ? 0 : -1}
                            type="button"
                            className={`px-3 py-1.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === "signup" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                            onClick={() => switchTab("signup")}
                        >
                            Sign up
                        </button>
                    </div>
                </CardHeader>
                <div
                    id="auth-panel"
                    role="tabpanel"
                    aria-labelledby={tab === "signin" ? "tab-signin" : "tab-signup"}
                >
                    <form onSubmit={handleSubmit}>
                        <CardContent className="flex flex-col gap-3">
                        {tab === "signup" && (
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="auth-name">Name</Label>
                                <Input
                                    id="auth-name"
                                    type="text"
                                    placeholder="Your name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    required
                                    autoComplete="name"
                                />
                            </div>
                        )}
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="auth-email">Email</Label>
                            <Input
                                id="auth-email"
                                type="email"
                                placeholder="you@example.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                autoComplete="email"
                                autoFocus
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="auth-password">Password</Label>
                            <Input
                                id="auth-password"
                                type="password"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                autoComplete={tab === "signin" ? "current-password" : "new-password"}
                            />
                        </div>
                        {error && <p className="text-sm text-destructive">{error}</p>}
                    </CardContent>
                    <CardFooter>
                        <Button
                            type="submit"
                            className="w-full"
                            disabled={loading || !email || !password || (tab === "signup" && !name)}
                        >
                            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {loading ? (tab === "signin" ? "Signing in…" : "Creating account…") : (tab === "signin" ? "Sign in" : "Create account")}
                        </Button>
                    </CardFooter>
                    </form>
                </div>
            </Card>
        </div>
    );
}
