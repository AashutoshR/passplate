import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { localDate, localTime } from "@pass/shared";

const TZ = "Europe/London";

/** Guests, day, go: the quickest way to a table, straight from the first screen. */
export function BookingBar({ tone = "light" }: { tone?: "light" | "dark" }) {
  const navigate = useNavigate();
  const [party, setParty] = useState(2);
  const options = useMemo(() => {
    const out: { date: string; label: string }[] = [];
    for (let i = 0; out.length < 14 && i < 30; i++) {
      const d = new Date(Date.now() + i * 86_400_000);
      const date = localDate(TZ, d);
      const noon = new Date(`${date}T12:00:00Z`);
      if (noon.getUTCDay() === 1) continue; // Closed on Mondays.
      // After half past eight tonight is fully booked online; start with tomorrow.
      if (i === 0 && localTime(new Date().toISOString(), TZ) >= "20:30") continue;
      out.push({
        date,
        label:
          i === 0
            ? "Today"
            : i === 1
              ? "Tomorrow"
              : noon.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
      });
    }
    return out;
  }, []);
  const [date, setDate] = useState(options[0]?.date ?? "");

  const light = tone === "light";
  const field = `h-14 w-full appearance-none border-0 bg-transparent pr-8 pl-4 text-[1.05rem] outline-none ${light ? "text-cream" : "text-espresso"}`;
  const optionCls = "text-espresso";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void navigate({ to: "/book", search: { party, date } });
      }}
      className={`grid w-full max-w-2xl grid-cols-2 border sm:grid-cols-[1fr_1.4fr_auto] ${
        light ? "border-cream/35 bg-espresso/35 backdrop-blur-md" : "border-espresso/20 bg-cream"
      }`}
      aria-label="Find a table"
    >
      <label className={`relative border-r ${light ? "border-cream/25" : "border-espresso/15"}`}>
        <span className="sr-only">Guests</span>
        <select value={party} onChange={(e) => setParty(Number(e.target.value))} className={field}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n} className={optionCls}>
              {n} {n === 1 ? "guest" : "guests"}
            </option>
          ))}
        </select>
        <Chevron light={light} />
      </label>
      <label className="relative">
        <span className="sr-only">Day</span>
        <select value={date} onChange={(e) => setDate(e.target.value)} className={field}>
          {options.map((o) => (
            <option key={o.date} value={o.date} className={optionCls}>
              {o.label}
            </option>
          ))}
        </select>
        <Chevron light={light} />
      </label>
      <button type="submit" className={`cta col-span-2 px-7 py-4 sm:col-span-1 ${light ? "cta-light" : "cta-dark"}`}>
        <span>Find a table</span>
      </button>
    </form>
  );
}

function Chevron({ light }: { light: boolean }) {
  return (
    <svg aria-hidden="true" width="10" height="6" viewBox="0 0 10 6" className={`pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 ${light ? "text-cream/70" : "text-umber"}`}>
      <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}
