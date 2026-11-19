import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ApiError, api } from "../lib/api";
import { storage } from "../lib/ids";
import { KitchenBoard, type KitchenSession } from "../components/kitchen";
import { Logo } from "../components/brand";

/** Kitchen display (FR-10 to FR-13). Client only: the device code lives on the device. */
export const Route = createFileRoute("/kitchen/$slug")({
  head: () => ({
    meta: [{ title: "Kitchen · PassPlate" }, { name: "theme-color", content: "#0b0b0a" }],
  }),
  component: KitchenPage,
});

const sessionKey = (slug: string) => `pass:kitchen:${slug}`;

function KitchenPage() {
  const { slug } = Route.useParams();
  const [session, setSession] = useState<KitchenSession | null | undefined>(undefined);

  useEffect(() => setSession(storage.get<KitchenSession | null>(sessionKey(slug), null)), [slug]);

  const logout = () => {
    storage.remove(sessionKey(slug));
    setSession(null);
  };

  if (session === undefined) return <div className="theme-dark min-h-dvh" />;
  if (!session) {
    return (
      <KitchenLogin
        slug={slug}
        onDone={(s) => {
          storage.set(sessionKey(slug), s);
          setSession(s);
        }}
      />
    );
  }
  return <KitchenBoard slug={slug} session={session} onLogout={logout} />;
}

function KitchenLogin({ slug, onDone }: { slug: string; onDone: (s: KitchenSession) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ location: { id: string; name: string } }>("/v1/kitchen/login", {
        method: "POST",
        json: { slug, code: code.trim() },
      });
      onDone({ locationId: res.location.id, locationName: res.location.name, token: code.trim() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Cannot reach the server. Check the connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="theme-dark grid min-h-dvh lg:grid-cols-2">
      <div className="hidden border-r-2 border-rule p-10 lg:flex lg:flex-col lg:justify-between">
        <Logo tone="light" />
        <h2 className="font-serif text-7xl leading-[0.95]">
          Service <em className="text-volt">starts</em>
          <br />
          here.
        </h2>
        <p className="label">Kitchen display · PassPlate</p>
      </div>
      <div className="flex items-center justify-center px-6">
        <form onSubmit={submit} className="rise w-full max-w-sm">
          <div className="lg:hidden">
            <Logo tone="light" />
          </div>
          <p className="label mt-10 lg:mt-0">[ Kitchen display ]</p>
          <h1 className="mt-3 font-serif text-5xl leading-none">Sign in the line.</h1>
          <p className="mt-3 text-stone">Enter this restaurant's kitchen device code.</p>
          <label className="mt-8 block">
            <span className="label mb-2 block">Device code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              autoComplete="off"
              className="w-full border-2 border-rule bg-coal px-4 py-3.5 font-mono text-lg text-bone outline-none focus:border-volt"
            />
          </label>
          {error && (
            <p role="alert" className="drop mt-4 border-2 border-ember px-4 py-2.5 text-ember">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || !code.trim()} className="btn btn-primary mt-8 w-full px-5 py-4">
            {busy ? "Checking…" : "Open the kitchen →"}
          </button>
        </form>
      </div>
    </main>
  );
}
