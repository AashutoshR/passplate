import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  MAX_PARTY,
  channels,
  localDate,
  type AvailabilityView,
  type MenuView,
  type ReservationView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useAccount } from "../lib/account";
import { RealtimeClient, type LinkStatus } from "../lib/realtime";
import { SITE } from "../lib/site";
import { SiteFooter, SiteHeader } from "../components/brand";
import { DishPhoto } from "../components/dishes";

export const Route = createFileRoute("/book")({
  validateSearch: (s: Record<string, unknown>): { party?: number; date?: string } => ({
    party: Number(s.party) >= 1 && Number(s.party) <= MAX_PARTY ? Number(s.party) : undefined,
    date: typeof s.date === "string" && /^d{4}-d{2}-d{2}$/.test(s.date) ? s.date : undefined,
  }),
  loader: () => api<MenuView>(`/v1/locations/${SITE.slug}/menu`),
  head: () => ({
    meta: [
      { title: "Book a table · PassPlate" },
      { name: "description", content: "Book a table at PassPlate on Wharf Street. See live availability and choose your time." },
    ],
  }),
  component: BookPage,
});

const DAYS_SHOWN = 21;
const CLOSED_WEEKDAYS = new Set([1]); // Monday

function days(timeZone: string) {
  const out: { date: string; weekday: string; day: string; month: string; closed: boolean }[] = [];
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const date = localDate(timeZone, d);
    const noon = new Date(`${date}T12:00:00Z`);
    out.push({
      date,
      weekday: i === 0 ? "Today" : i === 1 ? "Tomorrow" : noon.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
      day: noon.toLocaleDateString("en-GB", { day: "numeric", timeZone: "UTC" }),
      month: noon.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
      closed: CLOSED_WEEKDAYS.has(noon.getUTCDay()),
    });
  }
  return out;
}

export function longDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function BookPage() {
  const menu = Route.useLoaderData();
  const loc = menu.location;
  const navigate = useNavigate();
  const { user } = useAccount();
  const strip = useMemo(() => days(loc.timezone), [loc.timezone]);
  const search = Route.useSearch();

  const [party, setParty] = useState(search.party ?? 2);
  const [date, setDate] = useState(() =>
    search.date && strip.some((d) => d.date === search.date && !d.closed)
      ? search.date
      : (strip.find((d) => !d.closed)?.date ?? strip[0]!.date),
  );
  const [time, setTime] = useState<string | null>(null);
  const [avail, setAvail] = useState<AvailabilityView | null>(null);
  const [loading, setLoading] = useState(true);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [justTaken, setJustTaken] = useState<string | null>(null);
  // Late in the evening today is full; open on the next day that has times instead.
  const advanced = useRef(Boolean(search.date));

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setName((n) => n || user.name);
    setPhone((p) => p || user.phone || "");
    setEmail((e) => e || user.email);
  }, [user]);

  const load = useCallback(async () => {
    const a = await api<AvailabilityView>(`/v1/locations/${loc.slug}/availability?date=${date}&party=${party}`);
    if (!advanced.current && date === strip[0]!.date && !a.slots.some((s) => s.available)) {
      advanced.current = true;
      const next = strip.find((d, i) => i > 0 && !d.closed);
      if (next) {
        setDate(next.date);
        return a.seq;
      }
    }
    advanced.current = true;
    setAvail(a);
    setLoading(false);
    // Someone else booked the time this guest picked: say so, keep everything else.
    setTime((t) => {
      if (t && !a.slots.find((s) => s.time === t)?.available) {
        setJustTaken(t);
        return null;
      }
      return t;
    });
    return a.seq;
  }, [loc.slug, date, party, strip]);

  useEffect(() => {
    setLoading(true);
    setJustTaken(null);
    load().catch(() => setLoading(false));
  }, [load]);

  // Live: when anyone books or cancels, this day's times refresh by themselves.
  useEffect(() => {
    const client = new RealtimeClient({
      channels: [channels.availability(loc.id)],
      since: menu.seq,
      onEvent: (e) => {
        if (e.type === "availability.changed") void load().catch(() => {});
      },
      onResync: load,
      onStatus: setLink,
    });
    client.start();
    return () => client.stop();
  }, [loc.id, menu.seq, load]);

  const lunch = avail?.slots.filter((s) => s.time < "17:00") ?? [];
  const dinner = avail?.slots.filter((s) => s.time >= "17:00") ?? [];
  const free = avail?.slots.filter((s) => s.available).length ?? 0;

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (!time) return;
    setSending(true);
    setError(null);
    try {
      const r = await api<ReservationView>("/v1/reservations", {
        method: "POST",
        json: { locationSlug: loc.slug, date, time, party, name, phone, email, notes },
      });
      await navigate({ to: "/booking/$code", params: { code: r.code } });
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = (err.details as { message: string }[] | undefined)?.[0]?.message;
        setError(detail ?? err.message);
        if (err.code === "fully_booked") void load();
      } else setError("No connection. Nothing has been booked yet. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="overflow-x-clip">
      <SiteHeader />
      <main className="mx-auto grid max-w-[1320px] gap-14 px-5 pt-16 pb-28 md:px-10 lg:grid-cols-[1fr_400px] lg:gap-20 lg:pt-24">
        <div className="min-w-0">
          <p className="eyebrow fade-up text-brass">Book a table</p>
          <span className="rule fade-up mt-5" aria-hidden="true" />
          <h1 className="display mt-7 text-[clamp(3rem,7vw,5.6rem)]">
            <span className="line-in" style={{ ["--delay" as string]: "100ms" }}>
              Join us at the table.
            </span>
          </h1>
          <p className="fade-up mt-6 max-w-xl text-lg leading-relaxed text-umber" style={{ ["--delay" as string]: "250ms" }}>
            Choose a day and a time. What you see is live: if someone books the last table while you are looking, it
            disappears here too. Tables for up to {MAX_PARTY}; for more, call us on{" "}
            <a href={SITE.phoneHref} className="draw text-espresso">
              {SITE.phone}
            </a>
            .
          </p>

          <form onSubmit={book} className="mt-14 space-y-14">
            <fieldset>
              <legend className="eyebrow mb-5 text-brass">1 · How many of you</legend>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                  <Choice key={n} on={party === n} onClick={() => setParty(n)} label={`${n} ${n === 1 ? "guest" : "guests"}`}>
                    {n}
                  </Choice>
                ))}
                <label className="relative">
                  <span className="sr-only">More guests</span>
                  <select
                    value={party > 8 ? party : ""}
                    onChange={(e) => e.target.value && setParty(Number(e.target.value))}
                    className={`h-14 appearance-none border px-5 pr-10 text-lg outline-none focus-visible:border-espresso ${
                      party > 8 ? "border-espresso bg-espresso text-cream" : "border-espresso/25 bg-transparent"
                    }`}
                  >
                    <option value="">9+</option>
                    {Array.from({ length: MAX_PARTY - 8 }, (_, i) => i + 9).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-sm">
                    ▾
                  </span>
                </label>
              </div>
            </fieldset>

            <fieldset>
              <legend className="eyebrow mb-5 text-brass">2 · Which day</legend>
              <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-2 md:mx-0 md:px-0">
                {strip.map((d) => {
                  const on = d.date === date;
                  return (
                    <button
                      key={d.date}
                      type="button"
                      disabled={d.closed}
                      aria-pressed={on}
                      onClick={() => {
                        setDate(d.date);
                        setTime(null);
                      }}
                      className={`flex w-[76px] shrink-0 flex-col items-center border py-3 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        on ? "border-espresso bg-espresso text-cream" : "border-espresso/20 hover:border-espresso"
                      }`}
                    >
                      <span className="eyebrow text-[0.6rem]">{d.weekday}</span>
                      <span className="mt-1 font-serif text-[1.9rem] leading-none">{d.day}</span>
                      <span className={`mt-1 text-xs ${on ? "text-cream/70" : "text-taupe"}`}>{d.closed ? "Closed" : d.month}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-5 flex w-full flex-wrap items-baseline justify-between gap-3">
                <span className="eyebrow text-brass">3 · What time</span>
                <span className="eyebrow flex items-center gap-2 text-taupe" aria-live="polite">
                  <span className={`size-1.5 rounded-full ${link === "live" ? "pulse-dot bg-[#2f7a55]" : "bg-taupe"}`} aria-hidden="true" />
                  {link === "live" ? "Live availability" : "Checking every few seconds"}
                </span>
              </legend>
              {justTaken && (
                <p role="alert" className="drop mb-5 border border-brass px-4 py-3 text-umber">
                  {justTaken} was just booked by someone else. Here is what is still free.
                </p>
              )}
              {loading && !avail ? (
                <SlotSkeleton />
              ) : avail?.closed ? (
                <p className="border border-espresso/15 px-5 py-6 text-umber">We are closed on {longDate(date)}. Pick another day.</p>
              ) : free === 0 ? (
                <p className="border border-espresso/15 px-5 py-6 text-umber">
                  Fully booked for {party} on {longDate(date)}. Try another day, or call us: we keep the bar for walk-ins.
                </p>
              ) : (
                <div className={`space-y-8 transition-opacity ${loading ? "opacity-50" : ""}`}>
                  {[
                    ["Lunch", lunch],
                    ["Dinner", dinner],
                  ].map(([label, slots]) =>
                    (slots as typeof lunch).length === 0 ? null : (
                      <div key={label as string}>
                        <p className="mb-3 font-serif text-xl">{label as string}</p>
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 xl:grid-cols-8">
                          {(slots as typeof lunch).map((s) => (
                            <button
                              key={s.time}
                              type="button"
                              disabled={!s.available}
                              aria-pressed={time === s.time}
                              onClick={() => {
                                setTime(s.time);
                                setJustTaken(null);
                              }}
                              className={`tabular border py-3 text-[0.95rem] transition-colors disabled:cursor-not-allowed disabled:border-transparent disabled:text-taupe/60 disabled:line-through ${
                                time === s.time ? "border-espresso bg-espresso text-cream" : "border-espresso/20 hover:border-espresso"
                              }`}
                            >
                              {s.time}
                            </button>
                          ))}
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </fieldset>

            <fieldset disabled={!time} className="transition-opacity disabled:opacity-40">
              <legend className="eyebrow mb-5 text-brass">4 · Your details</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" value={name} onChange={setName} autoComplete="name" required />
                <Field label="Phone" value={phone} onChange={setPhone} autoComplete="tel" type="tel" required hint="Only if something changes" />
                <Field label="Email (optional)" value={email} onChange={setEmail} autoComplete="email" type="email" />
                <Field label="Anything we should know?" value={notes} onChange={setNotes} hint="Allergies, a birthday, a high chair" />
              </div>
              {!user && (
                <p className="mt-5 text-umber">
                  <Link to="/account" className="draw text-espresso">
                    Sign in
                  </Link>{" "}
                  to keep your bookings together and collect rewards.
                </p>
              )}
            </fieldset>

            {error && (
              <p role="alert" className="drop border border-brass px-4 py-3 text-espresso">
                {error}
              </p>
            )}
          </form>
        </div>

        {/* The summary follows you down the page and holds the one button. */}
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <div className="border border-espresso/15 bg-linen">
            <DishPhoto src="/media/dish-burrata.jpg" alt="" className="aspect-[16/10] w-full" eager />
            <div className="p-7">
              <p className="eyebrow text-brass">Your table</p>
              <dl className="mt-5 divide-y divide-espresso/12 border-y border-espresso/12">
                <Row term="Guests" value={`${party}`} />
                <Row term="Day" value={longDate(date)} />
                <Row term="Time" value={time ?? "Choose a time"} muted={!time} />
                <Row term="Where" value={SITE.street} />
              </dl>
              <button
                type="button"
                onClick={(e) => void book(e as unknown as React.FormEvent)}
                disabled={!time || !name.trim() || phone.trim().length < 6 || sending}
                className="cta cta-dark mt-7 w-full px-6 py-4"
              >
                <span>{sending ? "Booking…" : time ? `Book for ${party} at ${time}` : "Choose a time"}</span>
              </button>
              <p className="mt-4 text-center text-sm text-taupe">Free to book. Cancel any time from your confirmation.</p>
            </div>
          </div>
        </aside>
      </main>
      <SiteFooter />
    </div>
  );
}

function Choice({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      className={`tabular grid size-14 place-items-center border text-lg transition-colors ${
        on ? "border-espresso bg-espresso text-cream" : "border-espresso/25 hover:border-espresso"
      }`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  hint,
  type = "text",
  autoComplete,
  required,
  id,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  id?: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-taupe">{hint}</span>}
      </span>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-espresso/25 bg-cream px-4 py-3.5 text-lg text-espresso outline-none placeholder:text-taupe focus:border-espresso"
      />
    </label>
  );
}

function Row({ term, value, muted }: { term: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="text-sm text-taupe">{term}</dt>
      <dd className={`text-right ${muted ? "text-taupe" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

function SlotSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 xl:grid-cols-8" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => (
        <span key={i} className="h-12 animate-pulse bg-espresso/[0.06]" />
      ))}
    </div>
  );
}
