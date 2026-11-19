import { useState } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { localDate, localTime, type ReservationView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { SITE, mapsHref } from "../lib/site";
import { SiteFooter, SiteHeader } from "../components/brand";
import { DishPhoto } from "../components/dishes";
import { longDate } from "./book";

const TZ = "Europe/London";

export const Route = createFileRoute("/booking/$code")({
  loader: async ({ params }) => {
    try {
      return await api<ReservationView>(`/v1/reservations/${encodeURIComponent(params.code)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound();
      throw err;
    }
  },
  head: () => ({ meta: [{ title: "Your booking · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: BookingPage,
});

/** A calendar file the guest can add to their phone. Built here, nothing leaves the browser. */
function icsHref(r: ReservationView): string {
  const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PassPlate//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${r.code}@passplate`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(r.startsAt)}`,
    `DTEND:${stamp(r.endsAt)}`,
    `SUMMARY:Dinner at PassPlate (${r.party})`,
    `LOCATION:${SITE.street}\\, ${SITE.city}`,
    `DESCRIPTION:Booking ${r.code}. Call ${SITE.phone} if your plans change.`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join("\r\n"))}`;
}

function BookingPage() {
  const initial = Route.useLoaderData();
  const [r, setR] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const date = localDate(TZ, new Date(r.startsAt));
  const live = r.status === "booked";
  const headline =
    r.status === "cancelled"
      ? "Booking cancelled."
      : r.status === "completed"
        ? "Thank you for coming."
        : r.status === "seated"
          ? "Enjoy your meal."
          : r.status === "no_show"
            ? "We missed you."
            : "You're booked.";

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      setR(await api<ReservationView>(`/v1/reservations/${r.code}/cancel`, { method: "POST" }));
      setConfirming(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No connection. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-x-clip">
      <SiteHeader />
      <main className="mx-auto grid max-w-[1180px] gap-14 px-5 pt-16 pb-28 md:px-10 lg:grid-cols-[1fr_460px] lg:pt-24">
        <div>
          <p className="eyebrow fade-up text-brass">Booking {r.code}</p>
          <span className="rule fade-up mt-5" aria-hidden="true" />
          <h1 className="display mt-7 text-[clamp(3rem,7vw,5.4rem)]">
            <span className="line-in">{headline}</span>
          </h1>
          <p className="fade-up mt-6 max-w-lg text-lg leading-relaxed text-umber" style={{ ["--delay" as string]: "200ms" }}>
            {live
              ? `A table for ${r.party} on ${longDate(date)} at ${localTime(r.startsAt, TZ)}. Quote ${r.code} if you call us.`
              : r.status === "cancelled"
                ? "Your table has been released. We hope to see you another time."
                : `Booking ${r.code} for ${r.party}.`}
          </p>

          <div className="fade-up mt-10 flex flex-wrap gap-3" style={{ ["--delay" as string]: "300ms" }}>
            {live && (
              <a href={icsHref(r)} download={`passplate-${r.code}.ics`} className="cta cta-dark px-7 py-4">
                <span>Add to calendar</span>
              </a>
            )}
            <a href={mapsHref} target="_blank" rel="noreferrer" className="cta cta-outline px-7 py-4">
              <span>Directions</span>
            </a>
            {r.status === "cancelled" && (
              <Link to="/book" className="cta cta-dark px-7 py-4">
                <span>Book again</span>
              </Link>
            )}
          </div>

          {live && (
            <div className="mt-16 border-t border-espresso/15 pt-8">
              {!confirming ? (
                <button type="button" onClick={() => setConfirming(true)} className="eyebrow -my-3 py-3 text-umber hover:text-espresso">
                  Cancel this booking
                </button>
              ) : (
                <div className="drop max-w-md border border-espresso/20 p-6">
                  <p className="font-serif text-2xl">Cancel your table?</p>
                  <p className="mt-2 text-umber">The table goes back to other guests straight away.</p>
                  {error && <p className="mt-3 text-espresso">{error}</p>}
                  <div className="mt-5 flex gap-3">
                    <button type="button" onClick={cancel} disabled={busy} className="cta cta-dark px-6 py-3">
                      <span>{busy ? "Cancelling…" : "Yes, cancel it"}</span>
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} className="cta cta-outline px-6 py-3">
                      <span>Keep it</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="docket self-start px-7 pt-8 pb-7 shadow-[0_24px_50px_-24px_rgb(23_36_30/0.45)]" style={{ ["--edge" as string]: "#f2ece1" }}>
          <DishPhoto src="/media/dish-steak.jpg" alt="" className="-mx-7 -mt-8 mb-7 aspect-[16/9]" eager />
          <p className="eyebrow text-ink/50">PassPlate · {SITE.street}</p>
          <p className="mt-3 font-serif text-5xl leading-none">{localTime(r.startsAt, TZ)}</p>
          <p className="mt-2 text-lg">{longDate(date)}</p>
          <dl className="mt-6 grid grid-cols-2 gap-y-4 border-t border-dashed border-ink/30 pt-5">
            <div>
              <dt className="eyebrow text-ink/50">Guests</dt>
              <dd className="mt-1 text-lg">{r.party}</dd>
            </div>
            <div>
              <dt className="eyebrow text-ink/50">Reference</dt>
              <dd className="tabular mt-1 text-lg tracking-[0.18em]">{r.code}</dd>
            </div>
            <div>
              <dt className="eyebrow text-ink/50">Name</dt>
              <dd className="mt-1 text-lg">{r.name}</dd>
            </div>
            <div>
              <dt className="eyebrow text-ink/50">Status</dt>
              <dd className="mt-1 text-lg capitalize">{r.status.replace("_", " ")}</dd>
            </div>
          </dl>
          {r.notes && <p className="mt-5 border-t border-dashed border-ink/30 pt-4 text-ink/70">“{r.notes}”</p>}
        </aside>
      </main>
      <SiteFooter />
    </div>
  );
}
