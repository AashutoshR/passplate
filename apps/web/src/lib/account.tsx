import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AccountView, RewardsView, UserView } from "@pass/shared";
import { api } from "./api";

interface AccountState {
  user: UserView | null;
  rewards: RewardsView | null;
  /** False until the first check with the server has answered. */
  ready: boolean;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<UserView>;
  register: (input: { name: string; email: string; password: string; phone?: string }) => Promise<UserView>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AccountState | null>(null);

/** Who is signed in. Read once on load from the session cookie, then kept here. */
export function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user: UserView | null; rewards: RewardsView | null; ready: boolean }>({
    user: null,
    rewards: null,
    ready: false,
  });

  const refresh = useCallback(async () => {
    try {
      const me = await api<AccountView | { user: null; rewards: null }>("/v1/account/me");
      setState({ user: me.user, rewards: me.rewards, ready: true });
    } catch {
      setState((s) => ({ ...s, ready: true }));
    }
  }, []);

  useEffect(() => {
    // Marks the page as interactive; automated tests wait for it before tapping.
    document.documentElement.dataset.hydrated = "true";
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (state.ready) document.documentElement.dataset.account = "ready";
  }, [state.ready]);

  const signIn = useCallback(async (email: string, password: string) => {
    const me = await api<AccountView>("/v1/account/login", { method: "POST", json: { email, password } });
    setState({ user: me.user, rewards: me.rewards, ready: true });
    return me.user;
  }, []);

  const register = useCallback(async (input: { name: string; email: string; password: string; phone?: string }) => {
    const me = await api<AccountView>("/v1/account/register", { method: "POST", json: input });
    setState({ user: me.user, rewards: me.rewards, ready: true });
    return me.user;
  }, []);

  const signOut = useCallback(async () => {
    await api("/v1/account/logout", { method: "POST" }).catch(() => {});
    setState({ user: null, rewards: null, ready: true });
  }, []);

  const value = useMemo(() => ({ ...state, refresh, signIn, register, signOut }), [state, refresh, signIn, register, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount(): AccountState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAccount outside AccountProvider");
  return v;
}

export const isStaff = (u: UserView | null) => Boolean(u && u.role !== "customer");
