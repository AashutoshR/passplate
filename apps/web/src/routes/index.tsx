import { Link, createFileRoute } from "@tanstack/react-router";
import { formatMoney, type MenuItemView, type MenuView } from "@pass/shared";
import { api } from "../lib/api";
import { useReveal } from "../lib/motion";
import { SITE } from "../lib/site";
import { SectionHead, SiteFooter, SiteHeader } from "../components/brand";
import { DishPhoto } from "../components/dishes";
import { BookingBar } from "../components/booking-bar";
import { HeroReel, ReelPause, useReel } from "../components/films";
import { KitchenFilm } from "../components/landing";
import { Contours, Fluted, Paper } from "../components/shaders";

export const Route = createFileRoute("/")({
  loader: async () => {
    try {
      return await api<MenuView>(`/v1/locations/${SITE.slug}/menu`);
    } catch {
      return null;
    }
  },
  head: () => ({
    meta: [
      { title: "PassPlate · Wood fire and fresh pasta on Wharf Street" },
      {
        name: "description",
        content:
          "An open kitchen with a wood fire, pasta rolled by hand every afternoon and a menu that follows the market. Eat in, order from your table, or collect on your way home.",
      },
    ],
  }),
  component: Home,
});

const HOUSE = [
  {
    label: "The fire",
    title: "Oak and charcoal",
    body: "Lit at noon and kept going until close. Steak, fish and flatbreads all cook over it.",
    image: "/media/dish-flatbread.jpg",
  },
  {
    label: "The pasta",
    title: "Rolled every afternoon",
    body: "Made by hand on the bench by the window, cut to order and never dried.",
    image: "/media/dish-pappardelle.jpg",
  },
  {
    label: "The market",
    title: "Whatever came in",
    body: "Fish from the morning boat and vegetables from two farms an hour away.",
    image: "/media/dish-oysters.jpg",
  },
];

function Home() {
  const menu = Route.useLoaderData();
  const page = useReveal<HTMLDivElement>();
  const reel = useReel();
  const featured = menu?.categories.flatMap((c) => c.items).filter((i) => i.featured) ?? [];
  const money = (m: number) => formatMoney(m, menu?.location.currency ?? "GBP");

  return (
    <div ref={page} className="overflow-x-clip">
      <SiteHeader over />

      {/* Hero: the kitchen on film, the name of the house, two ways in. */}
      <section className="relative isolate flex min-h-[100svh] flex-col items-center justify-center text-center text-cream">
        <HeroReel reel={reel} />
        <div className="mx-auto w-full max-w-5xl px-5 pt-28 pb-24">
          <p className="eyebrow fade-up text-cream/80" style={{ ["--delay" as string]: "100ms" }}>
            <span className="hidden sm:inline">Wood fire and fresh pasta · </span>Wharf Street, Bristol
          </p>
          <span className="rule fade-up mx-auto mt-7" style={{ ["--delay" as string]: "200ms" }} aria-hidden="true" />
          <h1 className="display mt-8 text-[clamp(3rem,8.2vw,7.6rem)]">
            <span className="line-in" style={{ ["--delay" as string]: "250ms" }}>
              Made over fire,
            </span>
            <span className="line-in" style={{ ["--delay" as string]: "420ms" }}>
              made by hand.
            </span>
          </h1>
          <p
            className="fade-up mx-auto mt-8 max-w-[32rem] text-lg leading-relaxed text-cream/85"
            style={{ ["--delay" as string]: "650ms" }}
          >
            Seasonal plates in an open kitchen. Book a table, or have dinner collected or brought to your door.
          </p>
          <div className="fade-up mx-auto mt-10 flex justify-center" style={{ ["--delay" as string]: "800ms" }}>
            <BookingBar />
          </div>
          <p className="fade-up eyebrow mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-cream/85" style={{ ["--delay" as string]: "950ms" }}>
            <Link to="/r/$slug" params={{ slug: SITE.slug }} className="draw">
              Order to collect
            </Link>
            <Link to="/r/$slug" params={{ slug: SITE.slug }} search={{ delivery: true }} className="draw">
              Delivery
            </Link>
            <Link to="/menu" className="draw">
              The menu
            </Link>
          </p>
        </div>
        <div className="absolute right-5 bottom-6 md:right-10 md:bottom-8">
          <ReelPause reel={reel} />
        </div>
      </section>

      {/* The house */}
      <section className="relative isolate">
        <Paper className="absolute inset-0 -z-10" />
        <div className="mx-auto max-w-[1320px] px-5 py-28 md:px-10 md:py-40">
          <div className="reveal mx-auto flex max-w-4xl flex-col items-center text-center">
            <p className="eyebrow text-brass">The house</p>
            <span className="rule mt-5" aria-hidden="true" />
            <p className="mt-8 font-serif text-[clamp(1.8rem,3.2vw,2.9rem)] leading-[1.25] text-balance">
              We light the oven at noon and cook until the last table leaves. Bread in the morning, pasta every
              afternoon, and a menu that changes with whatever the market brings in.
            </p>
          </div>
          <div className="mt-20 grid gap-12 md:mt-28 md:grid-cols-3 md:gap-8 lg:gap-12">
            {HOUSE.map((h, i) => (
              <article key={h.label} className="reveal text-center" style={{ ["--delay" as string]: `${i * 120}ms` }}>
                <DishPhoto src={h.image} alt="" className="aspect-[4/5]" />
                <p className="eyebrow mt-7 text-brass">{h.label}</p>
                <h3 className="mt-3 font-serif text-[1.9rem] leading-tight">{h.title}</h3>
                <p className="mx-auto mt-3 max-w-xs leading-relaxed text-umber">{h.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Three ways to eat with us */}
      <section className="mx-auto max-w-[1320px] px-5 pb-28 md:px-10 md:pb-36">
        <SectionHead label="Eat with us" title="At the table, or at home." />
        <div className="mt-16 grid gap-6 md:grid-cols-3">
          {[
            {
              label: "Book a table",
              title: "Dinner in the room",
              body: "Live availability for up to twelve. The counter and bar are kept for walk-ins.",
              image: "/media/dish-steak.jpg",
              cta: "Find a table",
              link: { to: "/book" as const },
            },
            {
              label: "Collect",
              title: "Ready when you are",
              body: "Order and pay online, and we will tell you the minute it is ready at the pass.",
              image: "/media/dish-margherita.jpg",
              cta: "Order to collect",
              link: { to: "/r/$slug" as const, params: { slug: SITE.slug } },
            },
            {
              label: "Delivery",
              title: "Brought to your door",
              body: "Within five kilometres, by bike. Watch your rider come across the city on the map.",
              image: "/media/dish-linguine.jpg",
              cta: "Order delivery",
              link: { to: "/r/$slug" as const, params: { slug: SITE.slug }, search: { delivery: true } },
            },
          ].map((w, i) => (
            <Link
              key={w.label}
              {...w.link}
              className="reveal group relative block overflow-hidden bg-espresso text-cream"
              style={{ ["--delay" as string]: `${i * 120}ms` }}
            >
              <DishPhoto src={w.image} alt="" className="aspect-[4/5] opacity-80 transition-opacity duration-700 group-hover:opacity-65" />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgb(23_36_30/0)_25%,rgb(23_36_30/0.55)_50%,rgb(23_36_30/0.94)_100%)]" />
              <div className="absolute inset-x-0 bottom-0 p-7">
                <p className="eyebrow text-gilt">{w.label}</p>
                <h3 className="mt-3 font-serif text-[2rem] leading-tight">{w.title}</h3>
                <p className="mt-2 max-w-xs text-cream/80">{w.body}</p>
                <span className="eyebrow mt-6 inline-flex items-center gap-3 border-b border-cream/40 pb-1 transition-[gap] duration-500 group-hover:gap-5">
                  {w.cta} <span aria-hidden="true">→</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Signature plates */}
      {featured.length > 0 && (
        <section className="border-t border-espresso/12 bg-linen">
          <div className="mx-auto max-w-[1320px] px-5 py-28 md:px-10 md:py-36">
            <SectionHead
              label="Signature plates"
              title="The dishes we are known for."
              intro="On the menu every day, whatever else changes."
            />
            <div className="mt-16 grid gap-x-8 gap-y-16 sm:grid-cols-2 lg:grid-cols-3">
              {featured.slice(0, 6).map((item, i) => (
                <Signature key={item.id} item={item} money={money} index={i} />
              ))}
            </div>
            <div className="reveal mt-20 flex justify-center">
              <Link to="/menu" className="cta cta-dark px-9 py-4">
                <span>View the full menu</span>
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* At the table */}
      <section className="relative isolate overflow-hidden bg-espresso text-cream">
        <Fluted image="/media/dish-steak.jpg" className="absolute inset-0 -z-10 opacity-60 grayscale" />
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgb(23_36_30/0.95)_0%,rgb(23_36_30/0.75)_50%,rgb(23_36_30/0.35)_100%)]" />
        <div className="mx-auto grid max-w-[1320px] gap-16 px-5 py-28 md:grid-cols-2 md:px-10 md:py-40">
          <div className="reveal">
            <p className="eyebrow text-gilt">At the table</p>
            <span className="rule mt-5" aria-hidden="true" />
            <h2 className="display mt-7 text-[clamp(2.5rem,5vw,4.4rem)]">Order when you are ready.</h2>
            <p className="mt-6 max-w-md text-lg leading-relaxed text-cream/80">
              Every table has its own code. Scan it to see tonight's menu, order as you go, and see each dish leave the
              kitchen. No waiting to catch someone's eye.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link to="/menu" className="cta cta-light px-8 py-4">
                <span>Tonight's menu</span>
              </Link>
              <Link to="/r/$slug" params={{ slug: SITE.slug }} className="cta cta-outline-light px-8 py-4">
                <span>Collect instead</span>
              </Link>
            </div>
          </div>
          <ol className="reveal self-end border-t border-cream/20" style={{ ["--delay" as string]: "150ms" }}>
            {[
              ["Scan", "The code on your table opens the menu. Nothing to download."],
              ["Choose", "Allergens on every dish. Notes go straight to the chef."],
              ["Relax", "Your phone tells you when each plate is on its way."],
            ].map(([t, b], i) => (
              <li key={t} className="grid grid-cols-[3.5rem_1fr] gap-4 border-b border-cream/20 py-7">
                <span className="eyebrow pt-2 text-gilt">0{i + 1}</span>
                <div>
                  <p className="font-serif text-[1.7rem]">{t}</p>
                  <p className="mt-1 text-cream/70">{b}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* The kitchen */}
      <section className="relative isolate overflow-hidden">
        <Contours className="absolute inset-0 -z-10 size-full text-espresso/[0.07]" seed={5} />
        <div className="mx-auto grid max-w-[1320px] items-center gap-14 px-5 py-28 md:grid-cols-2 md:gap-20 md:px-10 md:py-40">
          <div className="reveal aspect-[4/5] max-h-[720px] w-full">
            <KitchenFilm />
          </div>
          <div className="reveal" style={{ ["--delay" as string]: "150ms" }}>
            <p className="eyebrow text-brass">The kitchen</p>
            <span className="rule mt-5" aria-hidden="true" />
            <h2 className="display mt-7 text-[clamp(2.5rem,5vw,4.4rem)]">The kitchen is the room.</h2>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-umber">
              There is no wall between you and the stove. Sit at the counter and watch the fire, the pasta bench and the
              pass, where every plate is checked before it reaches you.
            </p>
            <Link to="/story" className="cta cta-outline mt-10 px-8 py-4">
              <span>Our story</span>
            </Link>
          </div>
        </div>
      </section>

      {/* Rewards */}
      <section className="relative isolate overflow-hidden bg-espresso text-cream">
        <div aria-hidden="true" className="absolute -top-40 left-1/2 -z-10 size-[42rem] -translate-x-1/2 rounded-full bg-brass/15 blur-3xl" />
        <div className="mx-auto grid max-w-[1320px] items-center gap-14 px-5 py-24 md:grid-cols-[1.1fr_1fr] md:px-10 md:py-32">
          <div className="reveal">
            <p className="eyebrow text-gilt">PassPlate rewards</p>
            <span className="rule mt-5" aria-hidden="true" />
            <h2 className="display mt-7 text-[clamp(2.5rem,5vw,4.4rem)]">Every eighth order, 20% off the next.</h2>
            <p className="mt-6 max-w-md text-lg leading-relaxed text-cream/75">
              A stamp for every meal served, collected or delivered. No cards to carry: sign in and we keep count.
            </p>
            <Link to="/account" className="cta cta-light mt-10 px-8 py-4">
              <span>Start collecting</span>
            </Link>
          </div>
          <ol className="reveal grid grid-cols-4 gap-4 sm:gap-6" aria-label="Eight stamps" style={{ ["--delay" as string]: "150ms" }}>
            {Array.from({ length: 8 }, (_, i) => (
              <li
                key={i}
                className={`grid aspect-square place-items-center rounded-full border ${
                  i < 5 ? "border-gilt bg-gilt text-espresso" : i === 7 ? "border-dashed border-gilt text-gilt" : "border-cream/30 text-cream/50"
                }`}
              >
                <span className="font-serif text-xl">{i === 7 ? "20%" : i + 1}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Visit */}
      <section className="border-t border-espresso/12">
        <div className="mx-auto max-w-[1320px] px-5 py-28 md:px-10 md:py-36">
          <SectionHead label="Visit" title="Come and eat." />
          <div className="mt-16 grid border-y border-espresso/15 text-center md:grid-cols-3">
            <div className="reveal py-10 md:px-8">
              <p className="eyebrow text-brass">Where</p>
              <p className="mt-5 font-serif text-[1.7rem] leading-snug">
                {SITE.street}
                <br />
                {SITE.city}
              </p>
            </div>
            <div
              className="reveal border-t border-espresso/15 py-10 md:border-t-0 md:border-l md:px-8"
              style={{ ["--delay" as string]: "100ms" }}
            >
              <p className="eyebrow text-brass">When</p>
              <ul className="mx-auto mt-5 max-w-xs space-y-2">
                {SITE.hours.map((h) => (
                  <li key={h.days} className="flex justify-between gap-4">
                    <span>{h.days}</span>
                    <span className="tabular text-umber">{h.time}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div
              className="reveal border-t border-espresso/15 py-10 md:border-t-0 md:border-l md:px-8"
              style={{ ["--delay" as string]: "200ms" }}
            >
              <p className="eyebrow text-brass">Book</p>
              <a href={SITE.phoneHref} className="draw mt-5 inline-block font-serif text-[1.7rem]">
                {SITE.phone}
              </a>
              <p className="mx-auto mt-3 max-w-xs text-umber">Tables for up to eight. The bar is kept for walk-ins.</p>
            </div>
          </div>
          <div className="reveal mt-12 flex justify-center">
            <Link to="/visit" className="eyebrow draw text-espresso">
              Getting here, hours and more
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function Signature({ item, money, index }: { item: MenuItemView; money: (m: number) => string; index: number }) {
  return (
    <Link
      to="/menu"
      hash={`dish-${item.id}`}
      className="reveal group block text-center"
      style={{ ["--delay" as string]: `${(index % 3) * 120}ms` }}
    >
      <DishPhoto src={item.image} alt={item.name} className="aspect-[4/5]" />
      <h3 className="mt-7 font-serif text-[1.65rem] leading-tight">{item.name}</h3>
      {item.description && <p className="mx-auto mt-2 max-w-xs text-umber">{item.description}</p>}
      <p className="tabular mt-3 text-brass">{money(item.priceMinor)}</p>
    </Link>
  );
}
