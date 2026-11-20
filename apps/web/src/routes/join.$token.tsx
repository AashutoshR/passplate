import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { InvitePreview } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useAccount } from "../lib/account";
import { Logo } from "../components/brand";
import { ROLE_LABEL } from "../components/staff";

/** Joining the team from an invite link (FR-22): choose a password, and you are in. */
export const Route = createFileRoute("/join/$token")({
  head: () => ({ meta: [{ title: "Join the team · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: JoinPage,
});

function JoinPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const { refresh } = useAccount();
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<InvitePreview>(`/v1/invites/${encodeURIComponent(token)}`)
      .then((i) => {
        setInvite(i);
        setForm((f) => ({ ...f, name: i.name ?? "", email: i.email ?? "" }));
      })
      .catch((err) => setProblem(err instanceof ApiError ? err.message : "No connection. Please try again."));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/invites/${encodeURIComponent(token)}/accept`, { method: "POST", json: form });
      await refresh();
      await navigate({ to: "/staff" });
    } catch (err) {
      setError(err instanceof ApiError ? ((err.details as { message: string }[] | undefined)?.[0]?.message ?? err.message) : "No connection. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full border border-espresso/25 bg-cream px-4 py-3.5 text-lg outline-none focus:border-espresso";
  return (
    <main className="mx-auto min-h-dvh max-w-md px-5 py-10">
      <Logo size="sm" />
      {problem ? (
        <div className="mt-20">
          <h1 className="display text-5xl">This link does not work.</h1>
          <p className="mt-4 text-lg text-umber">{problem}</p>
        </div>
      ) : !invite ? (
        <div className="mt-20 h-64 animate-pulse bg-linen" aria-label="Loading" />
      ) : (
        <>
          <p className="eyebrow mt-16 text-brass">
            {invite.restaurant} · {ROLE_LABEL[invite.role]}
          </p>
          <h1 className="display mt-4 text-5xl">Welcome to the team.</h1>
          <p className="mt-3 text-lg text-umber">Choose a password and you can start straight away.</p>
          <form onSubmit={submit} className="mt-10 grid gap-4">
            <label>
              <span className="mb-2 block text-sm font-medium">Your name</span>
              <input id="join-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" required className={field} />
            </label>
            <label>
              <span className="mb-2 block text-sm font-medium">Work email</span>
              <input
                id="join-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                readOnly={Boolean(invite.email)}
                autoComplete="username"
                required
                className={`${field} ${invite.email ? "text-umber" : ""}`}
              />
            </label>
            <label>
              <span className="mb-2 block text-sm font-medium">Password</span>
              <input
                id="join-password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="new-password"
                minLength={8}
                required
                className={field}
              />
              <span className="mt-1.5 block text-sm text-taupe">At least 8 characters.</span>
            </label>
            {error && (
              <p role="alert" className="border border-brass px-4 py-3">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className="cta cta-dark mt-2 px-7 py-4">
              <span>{busy ? "Setting you up…" : "Join"}</span>
            </button>
          </form>
        </>
      )}
    </main>
  );
}
