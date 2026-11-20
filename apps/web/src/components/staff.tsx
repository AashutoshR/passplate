import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { UserRole } from "@pass/shared";
import { ApiError } from "../lib/api";
import { useAccount } from "../lib/account";
import { SITE } from "../lib/site";
import { Logo } from "./brand";

const TABS: { to: string; label: string; roles: UserRole[] }[] = [
  { to: "/staff/floor", label: "Floor", roles: ["staff", "admin"] },
  { to: "/kitchen/passplate", label: "Kitchen", roles: ["staff", "admin"] },
  { to: "/staff/dispatch", label: "Dispatch", roles: ["staff", "admin"] },
  { to: "/staff/driver", label: "Deliveries", roles: ["driver", "admin"] },
  { to: "/staff/receipts", label: "Receipts", roles: ["staff", "admin"] },
  { to: "/staff/admin", label: "Admin", roles: ["admin"] },
  { to: "/staff/tables", label: "Table codes", roles: ["staff", "admin"] },
];

export const ROLE_LABEL: Record<UserRole, string> = {
  customer: "Guest",
  staff: "Front of house",
  driver: "Driver",
  admin: "Admin",
};

/**
 * Every staff screen sits in this frame: a bottle-green bar with the tabs a
 * role may open, and a sign-in panel for anyone who is not signed in.
 */
export function StaffShell({
  roles,
  children,
  wide = false,
  actions,
}: {
  roles: UserRole[];
  children: ReactNode;
  wide?: boolean;
  actions?: ReactNode;
}) {
  const { user, ready, signOut } = useAccount();
  const allowed = user && roles.includes(user.role);

  return (
    <div className="min-h-dvh bg-[#f6f2ea]">
      <header className="sticky top-0 z-30 bg-espresso text-cream">
        <div className={`mx-auto flex h-16 items-center gap-6 px-4 md:px-6 ${wide ? "max-w-none" : "max-w-[1440px]"}`}>
          <Logo size="sm" tone="light" />
          {user && user.role !== "customer" && (
            <nav className="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Staff">
              {TABS.filter((t) => t.roles.includes(user.role)).map((t) => (
                <Link
                  key={t.to}
                  to={t.to}
                  className="eyebrow shrink-0 px-3 py-2 text-[0.66rem] text-cream/70 transition-colors hover:text-cream"
                  activeProps={{ className: "bg-cream/10 text-cream" }}
                >
                  {t.label}
                </Link>
              ))}
            </nav>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-4">
            {actions}
            {user && (
              <>
                <span className="hidden text-sm text-cream/70 lg:inline">
                  {user.name} · {ROLE_LABEL[user.role]}
                </span>
                <button type="button" onClick={() => void signOut()} className="eyebrow text-[0.66rem] text-cream/70 hover:text-cream">
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      {!ready ? (
        <div className="min-h-[60vh]" />
      ) : !user ? (
        <StaffSignIn />
      ) : !allowed ? (
        <div className="mx-auto max-w-lg px-5 py-24 text-center">
          <p className="font-serif text-3xl">This screen is not for your role.</p>
          <p className="mt-3 text-umber">
            You are signed in as {user.name} ({ROLE_LABEL[user.role]}).{" "}
            {user.role === "customer" ? (
              <Link to="/account" className="draw text-espresso">
                Go to your account
              </Link>
            ) : (
              <Link to="/staff" className="draw text-espresso">
                Back to the staff screens
              </Link>
            )}
          </p>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function StaffSignIn() {
  const { signIn } = useAccount();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No connection. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-5 py-20">
      <p className="eyebrow text-brass">{SITE.name} staff</p>
      <h1 className="display mt-4 text-5xl">Sign in for service.</h1>
      <form onSubmit={submit} className="mt-10 grid gap-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Work email</span>
          <input
            id="staff-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            className="w-full border border-espresso/25 bg-cream px-4 py-3.5 text-lg outline-none focus:border-espresso"
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Password</span>
          <input
            id="staff-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full border border-espresso/25 bg-cream px-4 py-3.5 text-lg outline-none focus:border-espresso"
          />
        </label>
        {error && (
          <p role="alert" className="border border-brass px-4 py-3">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="cta cta-dark mt-2 px-7 py-4">
          <span>{busy ? "Signing in…" : "Sign in"}</span>
        </button>
      </form>
      <p className="mt-6 text-sm text-taupe">New to the team? Ask your manager for an invite link.</p>
    </main>
  );
}

/**
 * Floor colours. Staff read them from across the room, so each status has its
 * own hue and its name is always printed on the table too.
 */
export const STATUS_STYLE = {
  free: { fill: "#e3ece2", edge: "#2f7a55", ink: "#1f5a3d", dot: "#2f7a55" },
  reserved: { fill: "#f5e8cf", edge: "#b0863f", ink: "#7a5a22", dot: "#b0863f" },
  seated: { fill: "#dfe8f2", edge: "#2f5d8a", ink: "#244a70", dot: "#2f5d8a" },
  ordered: { fill: "#2f5d8a", edge: "#22476b", ink: "#ffffff", dot: "#2f5d8a" },
  eating: { fill: "#e8e1f2", edge: "#6a52a0", ink: "#4d3a7a", dot: "#6a52a0" },
  clearing: { fill: "#f6ddd6", edge: "#b0412e", ink: "#8a2e1f", dot: "#b0412e" },
} as const;
