import { Link, createFileRoute } from "@tanstack/react-router";
import { useReveal } from "../lib/motion";
import { SITE, mapsHref } from "../lib/site";
import { SiteFooter, SiteHeader } from "../components/brand";
import { Contours } from "../components/shaders";

export const Route = createFileRoute("/visit")({
  head: () => ({
    meta: [
      { title: "Visit · PassPlate" },
      { name: "description", content: `Opening hours, how to find us at ${SITE.street}, booking, allergies and accessibility.` },
    ],
  }),
  component: VisitPage,
});

const FAQ = [
  [
    "Do I need to book?",
    "For dinner on Friday and Saturday, yes. Call us for tables of up to eight. The bar and the counter are kept for walk-ins every day.",
  ],
  [
    "Can I order from my table?",
    "Yes. Every table has its own code. Scan it with your phone camera to see the menu, order as you go and follow each dish. You can always order with your server instead.",
  ],
  [
    "Can I collect a takeaway?",
    "Most of the menu can be ordered for pickup online. Give your name at the counter when it's ready; your phone will tell you when.",
  ],
  [
    "I have an allergy.",
    "Every dish lists its allergens, and you can leave a note for the chef with any order. Our kitchen handles nuts, gluten and shellfish, so please tell us when you arrive.",
  ],
  [
    "Is it accessible?",
    "There is step-free access from Wharf Street, an accessible toilet on the ground floor, and lower tables by the window. Assistance dogs are always welcome.",
  ],
  [
    "Private dining?",
    "The back room seats up to twenty around one long table with a set menu from the fire. Call us and we will put something together.",
  ],
] as const;

function VisitPage() {
  const page = useReveal<HTMLDivElement>();
  return (
    <div ref={page} className="overflow-x-clip">
      <SiteHeader />

      <header className="relative isolate overflow-hidden bg-linen">
        <Contours className="absolute inset-0 -z-10 size-full text-espresso/[0.08]" seed={8} />
        <div className="mx-auto max-w-[1320px] px-5 pt-20 pb-20 md:px-10 md:pt-28">
          <p className="eyebrow fade-up text-brass">Visit</p>
          <span className="rule fade-up mt-5" aria-hidden="true" />
          <h1 className="display mt-7 text-[clamp(3.2rem,8vw,7.5rem)]">
            <span className="line-in" style={{ ["--delay" as string]: "100ms" }}>
              {SITE.street.replace(/^\d+\s/, "")},
            </span>
            <span className="line-in" style={{ ["--delay" as string]: "250ms" }}>
              number {SITE.street.split(" ")[0]}.
            </span>
          </h1>
          <div className="fade-up mt-12 grid gap-8 border-t border-espresso/20 pt-8 md:grid-cols-3" style={{ ["--delay" as string]: "450ms" }}>
            <div>
              <p className="eyebrow text-brass">Address</p>
              <p className="mt-3 text-lg">
                {SITE.street}, {SITE.city}
              </p>
              <a href={mapsHref} target="_blank" rel="noreferrer" className="eyebrow draw mt-3 inline-block text-brass">
                Open in Maps
              </a>
            </div>
            <div>
              <p className="eyebrow text-brass">Bookings</p>
              <a href={SITE.phoneHref} className="draw mt-3 inline-block text-lg">
                {SITE.phone}
              </a>
            </div>
            <div>
              <p className="eyebrow text-brass">Getting here</p>
              <p className="mt-3 text-lg">Ten minutes' walk from Temple Meads. Harbour ferry stop at the end of the street.</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1320px] px-5 md:px-10">
        <section className="grid gap-10 py-24 md:grid-cols-[minmax(180px,1fr)_3fr]">
          <p className="reveal eyebrow text-brass">Hours</p>
          <div className="reveal">
            <ul className="border-t border-espresso/20">
              {SITE.hours.map((h) => (
                <li key={h.days} className="flex items-baseline justify-between gap-6 border-b border-espresso/15 py-5">
                  <span className="font-serif text-[clamp(1.6rem,3vw,2.6rem)]">{h.days}</span>
                  <span className={`tabular text-lg ${h.time === "Closed" ? "text-taupe" : ""}`}>{h.time}</span>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-umber">{SITE.kitchenNote}</p>
          </div>
        </section>

        <section className="grid gap-10 border-t border-espresso/20 pt-10 pb-28 md:grid-cols-[minmax(180px,1fr)_3fr]">
          <p className="reveal eyebrow text-brass">Good to know</p>
          <div className="grid gap-x-12 md:grid-cols-2">
            {FAQ.map(([q, a], i) => (
              <div key={q} className="reveal border-b border-espresso/15 py-8" style={{ ["--delay" as string]: `${(i % 2) * 100}ms` }}>
                <h2 className="font-serif text-[1.65rem] leading-snug">{q}</h2>
                <p className="mt-3 leading-relaxed text-umber">{a}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="reveal mb-28 flex flex-col items-center gap-8 border-t border-espresso/20 pt-20 text-center">
          <span className="rule" aria-hidden="true" />
          <h2 className="display max-w-3xl text-[clamp(2.4rem,4.6vw,4rem)]">Can't make it in? Take it home.</h2>
          <Link to="/r/$slug" params={{ slug: SITE.slug }} className="cta cta-dark px-7 py-4">
            <span>Order for pickup</span>
          </Link>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
