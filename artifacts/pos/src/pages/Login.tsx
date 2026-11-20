import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import {
  useLogin,
  useGetSettings,
  getGetSettingsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { PasswordInput } from "@/components/PasswordInput";
import type { User } from "@workspace/api-client-react";
import { ArrowLeft, Mail, Store, UserPlus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

type AuthView = "login" | "register" | "forgot" | "reset";

interface ForgotPasswordResponse {
  ok: boolean;
  delivery: "smtp" | "preview";
  message: string;
  previewCode?: string;
}

interface ResetPasswordResponse {
  ok: boolean;
  message: string;
}

export default function Login() {
  const [, navigate] = useLocation();
  const { refresh } = useAuth();
  const { toast } = useToast();
  const settings = useGetSettings({
    query: {
      queryKey: getGetSettingsQueryKey(),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });
  const login = useLogin();

  const [view, setView] = useState<AuthView>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [regName, setRegName] = useState("");
  const [regBusinessName, setRegBusinessName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirmPassword, setRegConfirmPassword] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);

  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deliveryInfo, setDeliveryInfo] = useState<{
    delivery: "smtp" | "preview";
    message: string;
    previewCode?: string;
  } | null>(null);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const businessName = settings.data?.businessName ?? "SmartBuy";
  const logoUrl = settings.data?.logoUrl ?? null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    try {
      await login.mutateAsync({
        data: { email: email.trim(), password },
      });
      await refresh();
      navigate("/");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Invalid email or password";
      toast({
        title: "Couldn't sign you in",
        description: message,
        variant: "destructive",
      });
    }
  }

  function openRegister() {
    setRegName("");
    setRegBusinessName("");
    setRegEmail(email.trim());
    setRegPassword("");
    setRegConfirmPassword("");
    setView("register");
  }

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    if (regName.trim().length < 2) {
      toast({
        title: "Name too short",
        description: "Enter at least 2 characters for your name.",
        variant: "destructive",
      });
      return;
    }
    if (!regEmail.trim()) return;
    if (regPassword.length < 6) {
      toast({
        title: "Password too short",
        description: "Use at least 6 characters.",
        variant: "destructive",
      });
      return;
    }
    if (regPassword !== regConfirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "Make sure both password fields match.",
        variant: "destructive",
      });
      return;
    }

    setIsRegistering(true);
    try {
      await customFetch<User>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name: regName.trim(),
          email: regEmail.trim(),
          businessName: regBusinessName.trim() || undefined,
          password: regPassword,
        }),
      });
      await refresh();
      toast({
        title: "Account created",
        description: "Welcome! Your workspace is ready.",
      });
      navigate("/");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not create account";
      toast({
        title: "Registration failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsRegistering(false);
    }
  }

  function openForgotPassword() {
    setResetEmail(email.trim());
    setResetCode("");
    setNewPassword("");
    setConfirmPassword("");
    setDeliveryInfo(null);
    setView("forgot");
  }

  async function onRequestResetCode(e: FormEvent) {
    e.preventDefault();
    const target = resetEmail.trim();
    if (!target) return;
    setIsSendingCode(true);
    try {
      const res = await customFetch<ForgotPasswordResponse>(
        "/api/auth/forgot-password",
        {
          method: "POST",
          body: JSON.stringify({ email: target }),
        },
      );
      setDeliveryInfo({
        delivery: res.delivery,
        message: res.message,
        previewCode: res.previewCode,
      });
      setView("reset");
      toast({
        title:
          res.delivery === "smtp"
            ? "Reset code sent"
            : "Verification code generated",
        description:
          res.delivery === "smtp"
            ? `Check ${target} for your 6-digit code.`
            : "SMTP is not configured; see the code displayed on screen.",
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not send reset code";
      toast({
        title: "Request failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsSendingCode(false);
    }
  }

  async function onResetPassword(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast({
        title: "Password too short",
        description: "Use at least 6 characters.",
        variant: "destructive",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "Make sure both password fields match.",
        variant: "destructive",
      });
      return;
    }

    setIsResetting(true);
    try {
      const res = await customFetch<ResetPasswordResponse>(
        "/api/auth/reset-password",
        {
          method: "POST",
          body: JSON.stringify({
            email: resetEmail.trim(),
            code: resetCode.trim(),
            newPassword,
          }),
        },
      );
      toast({
        title: "Password reset",
        description: res.message,
      });
      setEmail(resetEmail.trim());
      setPassword("");
      setResetCode("");
      setNewPassword("");
      setConfirmPassword("");
      setDeliveryInfo(null);
      setView("login");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not reset password";
      toast({
        title: "Reset failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="p-6">
          <div className="flex flex-col items-center text-center mb-6">
            <BrandBadge businessName={businessName} logoUrl={logoUrl} large />
            <h1 className="mt-3 text-xl font-bold">{businessName}</h1>
            <p className="text-sm text-muted-foreground">
              {view === "login"
                ? "Sign in to your point of sale"
                : view === "register"
                  ? "Create your own shop account"
                  : view === "forgot"
                    ? "Reset your password"
                    : "Enter your verification code"}
            </p>
          </div>

          {view === "login" && (
            <>
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoFocus
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Password</Label>
                    <button
                      type="button"
                      onClick={openForgotPassword}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <PasswordInput
                    id="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={login.isPending}
                >
                  {login.isPending ? "Signing in..." : "Sign in"}
                </Button>
              </form>

              <div className="mt-4 pt-4 border-t text-center">
                <p className="text-xs text-muted-foreground">
                  New here?{" "}
                  <button
                    type="button"
                    onClick={openRegister}
                    className="font-medium text-primary hover:underline"
                  >
                    Create an account
                  </button>
                </p>
              </div>

              <p className="mt-3 text-xs text-muted-foreground text-center">
                Demo account:{" "}
                <span className="font-medium">admin@smartbuy.co.ke</span> /{" "}
                <span className="font-medium">admin</span>
              </p>
            </>
          )}

          {view === "register" && (
            <form onSubmit={onRegister} className="space-y-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="reg-name">Your name</Label>
                <Input
                  id="reg-name"
                  autoFocus
                  autoComplete="name"
                  placeholder="Jane Doe"
                  minLength={2}
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-business">Business name (optional)</Label>
                <Input
                  id="reg-business"
                  placeholder="My Shop"
                  value={regBusinessName}
                  onChange={(e) => setRegBusinessName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-email">Email</Label>
                <Input
                  id="reg-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-password">Password</Label>
                <PasswordInput
                  id="reg-password"
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                  minLength={6}
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-confirm-password">Confirm password</Label>
                <PasswordInput
                  id="reg-confirm-password"
                  autoComplete="new-password"
                  placeholder="Repeat password"
                  minLength={6}
                  value={regConfirmPassword}
                  onChange={(e) => setRegConfirmPassword(e.target.value)}
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={isRegistering}
              >
                <UserPlus className="w-4 h-4 mr-2" />
                {isRegistering ? "Creating account..." : "Create account"}
              </Button>
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => setView("login")}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Already have an account? Sign in
                </button>
              </div>
            </form>
          )}

          {view === "forgot" && (
            <form onSubmit={onRequestResetCode} className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Enter the email address for your account and we will send you a
                6-digit reset code.
              </p>
              <div className="space-y-2">
                <Label htmlFor="reset-email">Email</Label>
                <Input
                  id="reset-email"
                  type="email"
                  autoFocus
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={isSendingCode}
              >
                <Mail className="w-4 h-4 mr-2" />
                {isSendingCode ? "Sending code..." : "Send reset code"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setView("login")}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to sign in
              </Button>
            </form>
          )}

          {view === "reset" && (
            <form onSubmit={onResetPassword} className="space-y-4">
              {deliveryInfo && (
                <div
                  className={
                    deliveryInfo.delivery === "preview"
                      ? "rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-1.5"
                      : "rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs"
                  }
                >
                  <p className="text-foreground">{deliveryInfo.message}</p>
                  {deliveryInfo.previewCode && (
                    <p className="font-mono text-base font-bold tracking-widest text-foreground">
                      {deliveryInfo.previewCode}
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="reset-code">6-digit reset code</Label>
                <Input
                  id="reset-code"
                  inputMode="numeric"
                  autoFocus
                  maxLength={6}
                  placeholder="123456"
                  value={resetCode}
                  onChange={(e) =>
                    setResetCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="reset-new-password">New password</Label>
                <PasswordInput
                  id="reset-new-password"
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="reset-confirm-password">
                  Confirm new password
                </Label>
                <PasswordInput
                  id="reset-confirm-password"
                  autoComplete="new-password"
                  placeholder="Repeat new password"
                  minLength={6}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={isResetting}
              >
                {isResetting ? "Resetting..." : "Reset password"}
              </Button>

              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => setView("login")}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to sign in
                </button>
                <button
                  type="button"
                  onClick={() => setView("forgot")}
                  className="text-primary hover:underline font-medium"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BrandBadge({
  businessName,
  logoUrl,
  large = false,
}: {
  businessName: string;
  logoUrl: string | null;
  large?: boolean;
}) {
  const size = large ? "w-16 h-16" : "w-10 h-10";
  const resolved = resolveLogoSrc(logoUrl);
  return (
    <div
      className={`${size} rounded-full border-2 border-primary/30 bg-primary/10 overflow-hidden flex items-center justify-center`}
    >
      {resolved ? (
        <img
          src={resolved}
          alt={businessName}
          className="w-full h-full object-cover"
        />
      ) : (
        <Store className={large ? "w-7 h-7 text-primary" : "w-5 h-5 text-primary"} />
      )}
    </div>
  );
}

function resolveLogoSrc(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("/objects/")) return `/api/storage${value}`;
  return value;
}
