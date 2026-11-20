import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  setAuthTokenGetter,
  setAuthTokenReceiver,
} from "@workspace/api-client-react";
import type { User } from "@workspace/api-client-react";

const AUTH_TOKEN_KEY = "smartbuy.authToken";

function readStoredToken(): string | null {
  try {
    return typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(AUTH_TOKEN_KEY)
      : null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (token) {
      sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

setAuthTokenGetter(readStoredToken);
setAuthTokenReceiver((token) => writeStoredToken(token));

type AuthContextValue = {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  refresh: () => Promise<void>;
  clear: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      retry: false,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });

  const isAuthError = (() => {
    const err = query.error as { status?: number } | null;
    return err?.status === 401;
  })();

  useEffect(() => {
    if (isAuthError) {
      writeStoredToken(null);
    }
  }, [isAuthError]);

  const value: AuthContextValue = {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated: !!query.data && !isAuthError,
    refresh: async () => {
      await queryClient.invalidateQueries({
        queryKey: getGetCurrentUserQueryKey(),
      });
    },
    clear: () => {
      writeStoredToken(null);
      queryClient.setQueryData(getGetCurrentUserQueryKey(), null);
      queryClient.removeQueries({ queryKey: getGetCurrentUserQueryKey() });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
