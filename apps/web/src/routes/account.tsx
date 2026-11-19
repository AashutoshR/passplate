import { useEffect, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { formatMoney, localDate, localTime, type ReservationView, type RewardsView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useAccount } from "../lib/account";
import { SITE } from "../lib/site";
import { SiteFooter, SiteHeader } from "../components/brand";
import { DishPhoto } from "../components/dishes";
import { Field, longDate } from "./book";

export const Route = createFileRoute("/account")({
  head: () => ({ meta: [{ title: "Your account · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: AccountPage,
});

interface MyOrder {
  id: string;
  number: number;
  type: string;
  status: string;
  totalMinor: number;
  discountMinor: number;
  currency: string;
  createdAt: string;
  items: number;
}

function AccountPage() {
  const { user, ready } = useAccount();
  const navigate = useNavigate();

  useEffect(() => {
    if (user && user.role !== "customer") void navigate({ to: "/staff" });
  }, [user, navigate]);

  return (
    <div className="overflow-x-clip">
      <SiteHeader />
      {!ready ? <div className="min-h-[70vh]" /> : user ? <Profile /> : <SignIn />}
      <SiteFooter />
    </div>
  );
}

function SignIn() {
  const { signIn, register } = useAccount();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await signIn(email, password);
      else await register({ name, email, password });
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = (err.details as { message: string }[] | undefined)?.[0]?.message;
        setError(detail ?? err.message);
      } else setError("No connection. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-[80vh] max-w-[1320px] items-stretch lg:grid-cols-2">
      <div className="relative hidden lg:block">
        <DishPhoto src="/media/dish-tart.jpg" alt="" className="absolute inset-0" eager />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_40%,rgb(23_36_30/0.75)_100%)]" />
        <div className="absolute inset-x-10 bottom-10 text-cream">
          <p className="eyebrow text-gilt">PassPlate rewards</p>
          <p className="mt-4 max-w-sm font-serif text-[2.2rem] leading-tight">Every eighth order, 20% off the next one.</p>
        </div>
      </div>
      <div className="flex flex-col justify-center px-5 py-20 md:px-16">
        <p className="eyebrow text-brass">{mode === "in" ? "Welcome back" : "Join us"}</p>
        <span className="rule mt-5" aria-hidden="true" />
        <h1 className="display mt-7 text-[clamp(2.8rem,5vw,4.4rem)]">{mode === "in" ? "Sign in." : "Create an account."}</h1>
        <p className="mt-4 max-w-md text-lg text-umber">
          {mode === "in"
            ? "See your bookings, follow your orders and keep track of your rewards."
            : "Collect a stamp with every order. The eighth one earns 20% off your next."}
        </p>

        <form onSubmit={submit} className="mt-10 grid max-w-md gap-4">
          {mode === "up" && <Field label="Name" value={name} onChange={setName} autoComplete="name" required id="account-name" />}
          <Field label="Email" value={email} onChange={setEmail} autoComplete="email" type="email" required id="account-email" />
          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            hint={mode === "up" ? "At least 8 characters" : undefined}
            required
            id="account-password"
          />
          {error && (
            <p role="alert" className="drop border border-brass px-4 py-3">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="cta cta-dark mt-2 px-7 py-4">
            <span>{busy ? "One moment…" : mode === "in" ? "Sign in" : "Create account"}</span>
          </button>
        </form>
        <p className="mt-8 text-umber">
          {mode === "in" ? "New here? " : "Already have an account? "}
          <button
            type="button"
            className="draw -my-2 inline-block py-2 text-espresso"
            onClick={() => {
              setMode(mode === "in" ? "up" : "in");
              setError(null);
            }}
          >
            {mode === "in" ? "Create an account" : "Sign in"}
          </button>
        </p>
        <p className="mt-3 text-sm text-taupe">Staff sign in here too.</p>
      </div>
    </main>
  );
}

function Profile() {
  const { user, signOut, refresh } = useAccount();
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [rewards, setRewards] = useState<RewardsView | null>(null);
  const [bookings, setBookings] = useState<ReservationView[] | null>(null);

  useEffect(() => {
    void api<{ orders: MyOrder[]; rewards: RewardsView }>("/v1/account/orders").then((r) => {
      setOrders(r.orders);
      setRewards(r.rewards);
    });
    void api<{ reservations: ReservationView[] }>("/v1/account/reservations").then((r) => setBookings(r.reservations));
    void refresh();
  }, [refresh]);

  const upcoming = bookings?.filter((b) => b.status === "booked" && new Date(b.endsAt) > new Date()) ?? [];

  return (
    <main className="mx-auto max-w-[1320px] px-5 pt-16 pb-28 md:px-10 md:pt-24">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="eyebrow text-brass">Your account</p>
          <span className="rule mt-5" aria-hidden="true" />
          <h1 className="display mt-7 text-[clamp(2.8rem,6vw,5rem)]">Hello, {user!.name.split(" ")[0]}.</h1>
        </div>
        <button type="button" onClick={() => void signOut()} className="cta cta-outline px-6 py-3">
          <span>Sign out</span>
        </button>
      </div>

      <section className="mt-14 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <RewardCard rewards={rewards} />
        <div className="border border-espresso/15 p-8">
          <p className="eyebrow text-brass">Coming up</p>
          {bookings === null ? (
            <p className="mt-6 text-taupe">Loading…</p>
          ) : upcoming.length === 0 ? (
            <div className="mt-6">
              <p className="font-serif text-2xl">No tables booked.</p>
              <Link to="/book" className="cta cta-dark mt-6 px-6 py-3.5">
                <span>Book a table</span>
              </Link>
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-espresso/12">
              {upcoming.map((b) => (
                <li key={b.id}>
                  <Link to="/booking/$code" params={{ code: b.code }} className="group flex items-center justify-between gap-4 py-4">
                    <span>
                      <span className="block font-serif text-2xl">{longDate(localDate("Europe/London", new Date(b.startsAt)))}</span>
                      <span className="text-umber">
                        {localTime(b.startsAt, "Europe/London")} · {b.party} {b.party === 1 ? "guest" : "guests"} · {b.code}
                      </span>
                    </span>
                    <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-16">
        <div className="flex items-baseline justify-between border-b border-espresso/15 pb-4">
          <h2 className="font-serif text-3xl">Your orders</h2>
          <Link to="/r/$slug" params={{ slug: SITE.slug }} className="eyebrow draw text-espresso">
            Order again
          </Link>
        </div>
        {orders === null ? (
          <p className="py-8 text-taupe">Loading…</p>
        ) : orders.length === 0 ? (
          <p className="py-8 text-umber">Nothing yet. Your first order earns your first stamp.</p>
        ) : (
          <ul className="divide-y divide-espresso/12">
            {orders.map((o) => (
              <li key={o.id}>
                <Link to="/order/$id" params={{ id: o.id }} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-6 gap-y-1 py-5 hover:bg-linen/60 sm:grid-cols-[6rem_1fr_10rem_8rem]">
                  <span className="tabular font-serif text-2xl">#{o.number}</span>
                  <span className="text-umber">
                    {new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} ·{" "}
                    {o.type === "dine_in" ? "At the table" : o.type === "pickup" ? "Collected" : "Delivered"} · {o.items}{" "}
                    {o.items === 1 ? "item" : "items"}
                  </span>
                  <span className="eyebrow hidden text-taupe sm:block">{o.status.replaceAll("_", " ")}</span>
                  <span className="tabular text-right">
                    {formatMoney(o.totalMinor, o.currency)}
                    {o.discountMinor > 0 && <span className="block text-sm text-brass">Reward used</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** Eight stamps, filled as orders are finished. The eighth turns into a reward. */
export function RewardCard({ rewards }: { rewards: RewardsView | null }) {
  const every = rewards?.every ?? 8;
  const stamps = rewards?.stamps ?? 0;
  const left = every - stamps;
  return (
    <div className="relative overflow-hidden bg-espresso p-8 text-cream">
      <div aria-hidden="true" className="absolute -top-24 -right-24 size-72 rounded-full bg-brass/20 blur-3xl" />
      <div className="relative">
        <div className="flex items-baseline justify-between gap-4">
          <p className="eyebrow text-gilt">Rewards</p>
          {rewards && <p className="text-sm text-cream/60">{rewards.completedOrders} orders so far</p>}
        </div>
        <p className="mt-5 font-serif text-[2rem] leading-tight">
          {rewards && rewards.available > 0
            ? `You have ${rewards.available === 1 ? "a reward" : `${rewards.available} rewards`} waiting: ${rewards.percent}% off your next order.`
            : `${left} more ${left === 1 ? "order" : "orders"} to ${rewards?.percent ?? 20}% off.`}
        </p>
        <ol className="mt-8 grid grid-cols-8 gap-2" aria-label={`${stamps} of ${every} stamps`}>
          {Array.from({ length: every }, (_, i) => {
            const filled = i < stamps;
            const last = i === every - 1;
            return (
              <li
                key={i}
                className={`grid aspect-square place-items-center rounded-full border transition-colors duration-700 ${
                  filled ? "border-gilt bg-gilt text-espresso" : last ? "border-dashed border-gilt/70 text-gilt" : "border-cream/25 text-cream/40"
                }`}
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <span className="text-[0.7rem] font-medium">{last ? "%" : filled ? "✓" : i + 1}</span>
              </li>
            );
          })}
        </ol>
        <p className="mt-6 text-sm text-cream/60">
          A stamp for every order that is served, collected or delivered. Up to {formatMoney(rewards?.capMinor ?? 1500, "GBP")} off.
        </p>
      </div>
    </div>
  );
}
