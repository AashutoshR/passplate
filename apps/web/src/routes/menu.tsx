import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { formatMoney, isAvailable, type MenuItemView, type MenuView } from "@pass/shared";
import { api } from "../lib/api";
import { useReveal } from "../lib/motion";
import { SITE } from "../lib/site";
import { SiteFooter, SiteHeader } from "../components/brand";
import { DietaryMarks, DishPhoto } from "../components/dishes";
import { Paper } from "../components/shaders";

export const Route = createFileRoute("/menu")({
  loader: () => api<MenuView>(`/v1/locations/${SITE.slug}/menu`),
  head: () => ({
    meta: [
      { title: "Menu · PassPlate" },
      { name: "description", content: "Bread and raw plates, fresh pasta, the wood fire, desserts, cocktails and wine." },
    ],
  }),
  component: MenuPage,
});

function MenuPage() {
  const menu = Route.useLoaderData();
  const page = useReveal<HTMLDivElement>();
  const money = (m: number) => formatMoney(m, menu.location.currency);
  const [diet, setDiet] = useState<"all" | "v" | "vg" | "gf">("all");
  const [query, setQuery] = useState("");
  // Vegan dishes are vegetarian too.
  const matches = (i: MenuItemView) =>
    (diet === "all" || i.dietary.includes(diet) || (diet === "v" && i.dietary.includes("vg"))) &&
    (!query.trim() || `${i.name} ${i.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const sections = useMemo(
    () => menu.categories.map((c) => ({ ...c, items: c.items.filter(matches) })).filter((c) => c.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu, diet, query],
  );
  const shown = sections.reduce((n, c) => n + c.items.length, 0);
  const total = menu.categories.reduce((n, c) => n + c.items.length, 0);
  const active = useActiveSection(sections.map((c) => `section-${c.id}`));

  return (
    <div ref={page} className="overflow-x-clip">
      <SiteHeader />

      <header className="relative isolate">
        <Paper className="absolute inset-0 -z-10" tone="linen" />
        <div className="mx-auto flex max-w-3xl flex-col items-center px-5 pt-24 pb-20 text-center md:pt-32">
          <p className="eyebrow fade-up text-brass">Lunch and dinner</p>
          <span className="rule fade-up mt-5" style={{ ["--delay" as string]: "100ms" }} aria-hidden="true" />
          <h1 className="display mt-7 text-[clamp(3.6rem,10vw,8rem)]">
            <span className="line-in" style={{ ["--delay" as string]: "150ms" }}>
              The menu
            </span>
          </h1>
          <p className="fade-up mt-6 max-w-xl text-lg leading-relaxed text-umber" style={{ ["--delay" as string]: "400ms" }}>
            It follows the market, so a few dishes come and go during the week. Everything is made here. Tell us about
            any allergy and the kitchen will look after you.
          </p>
          <Link
            to="/r/$slug"
            params={{ slug: SITE.slug }}
            className="cta cta-dark fade-up mt-10 px-8 py-4"
            style={{ ["--delay" as string]: "550ms" }}
          >
            <span>Order for pickup</span>
          </Link>
        </div>
      </header>

      {/* Sections, always one tap away. */}
      <nav aria-label="Menu sections" className="sticky top-[76px] z-30 border-y border-espresso/12 bg-cream/95 backdrop-blur-md">
        <div className="no-scrollbar overflow-x-auto">
          <div className="mx-auto flex w-max gap-8 px-5 md:px-10">
            {sections.map((c) => {
              const on = active === `section-${c.id}`;
              return (
                <a
                  key={c.id}
                  href={`#section-${c.id}`}
                  onClick={(e) => {
                    const target = document.getElementById(`section-${c.id}`);
                    if (!target) return;
                    e.preventDefault();
                    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                    target.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
                    history.replaceState(null, "", `#section-${c.id}`);
                  }}
                  className={`eyebrow relative shrink-0 py-4 transition-colors ${on ? "text-espresso" : "text-taupe hover:text-espresso"}`}
                >
                  {c.name}
                  <span
                    className="absolute inset-x-0 bottom-0 h-px origin-center bg-brass transition-transform duration-500"
                    style={{ transform: `scaleX(${on ? 1 : 0})` }}
                  />
                </a>
              );
            })}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-[1240px] px-5 md:px-10">
        <div className="flex flex-col gap-5 border-b border-espresso/12 py-8 md:flex-row md:items-center md:justify-between">
          <div role="radiogroup" aria-label="Dietary" className="flex flex-wrap gap-2">
            {(
              [
                ["all", "Everything"],
                ["v", "Vegetarian"],
                ["vg", "Vegan"],
                ["gf", "Gluten free"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={diet === k}
                onClick={() => setDiet(k)}
                className={`eyebrow border px-4 py-2.5 text-[0.64rem] transition-colors ${
                  diet === k ? "border-espresso bg-espresso text-cream" : "border-espresso/20 hover:border-espresso"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="relative md:w-80">
            <span className="sr-only">Search the menu</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the menu"
              className="w-full border-b border-espresso/30 bg-transparent py-2.5 pr-8 text-lg outline-none placeholder:text-taupe focus:border-espresso"
            />
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="absolute top-1/2 right-1 -translate-y-1/2 text-umber">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" fill="none" strokeWidth="1.3" />
              <path d="M11 11l4 4" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </label>
        </div>
        <p className="mt-4 text-sm text-taupe" aria-live="polite">
          {shown === total ? `${total} dishes and drinks` : `Showing ${shown} of ${total}`}
        </p>
        {sections.length === 0 && (
          <p className="py-24 text-center font-serif text-3xl text-umber">Nothing matches that. Try another word.</p>
        )}
        {sections.map((c) => (
          <section key={c.id} id={`section-${c.id}`} className="scroll-mt-[150px] pt-24 md:pt-32">
            <div className="reveal flex flex-col items-center text-center">
              <h2 className="display text-[clamp(2.4rem,4.4vw,3.6rem)]">{c.name}</h2>
              <span className="rule mt-5" aria-hidden="true" />
              {c.blurb && <p className="mt-5 text-umber">{c.blurb}</p>}
            </div>
            {c.image && diet === "all" && !query && (
              <DishPhoto src={c.image} alt="" className="reveal mt-12 aspect-[21/7] w-full" />
            )}
            <ul className="mt-12 grid gap-x-14 border-t border-espresso/12 md:grid-cols-2">
              {c.items.map((item, i) => (
                <Dish key={item.id} item={item} money={money} delay={(i % 2) * 90} />
              ))}
            </ul>
          </section>
        ))}

        <div className="reveal mt-32 grid gap-10 border-t border-espresso/15 py-14 text-center md:grid-cols-3">
          <div>
            <p className="eyebrow text-brass">Dietary marks</p>
            <p className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-2 text-umber">
              <span><span className="chip mr-1.5">V</span>Vegetarian</span>
              <span><span className="chip mr-1.5">VG</span>Vegan</span>
              <span><span className="chip mr-1.5">GF</span>Gluten free</span>
              <span><span className="chip mr-1.5 text-brass">Hot</span>Spicy</span>
            </p>
          </div>
          <div>
            <p className="eyebrow text-brass">Allergies</p>
            <p className="mx-auto mt-4 max-w-xs text-umber">
              Allergens are listed under every dish. Our kitchen handles nuts, gluten and shellfish, so please ask.
            </p>
          </div>
          <div>
            <p className="eyebrow text-brass">Service</p>
            <p className="mx-auto mt-4 max-w-xs text-umber">
              Prices include VAT. A discretionary 12.5% service charge is added for tables of six or more.
            </p>
          </div>
        </div>
      </main>

      <div className="mb-24" />
      <SiteFooter />
    </div>
  );
}

function Dish({ item, money, delay }: { item: MenuItemView; money: (m: number) => string; delay: number }) {
  const available = isAvailable(item);
  const low = item.stock !== null && item.stock > 0 && item.stock <= 5;
  return (
    <li
      id={`dish-${item.id}`}
      className="reveal group scroll-mt-[160px] border-b border-espresso/12 py-7"
      style={{ ["--delay" as string]: `${delay}ms` }}
    >
      <div className="flex gap-6">
        <DishPhoto src={item.image} alt="" className="size-24 shrink-0 md:size-[7.5rem]" />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-baseline gap-3">
            <h3 className={`font-serif text-[1.45rem] leading-[1.2] ${available ? "" : "text-taupe line-through decoration-1"}`}>
              {item.name}
            </h3>
            <span aria-hidden="true" className="mb-1.5 min-w-4 flex-1 border-b border-dotted border-espresso/30" />
            <span className="tabular shrink-0">{money(item.priceMinor)}</span>
          </div>
          {item.description && <p className="mt-1.5 leading-relaxed text-umber">{item.description}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <DietaryMarks dietary={item.dietary} />
            {!available && <span className="chip text-brass">Sold out tonight</span>}
            {available && low && <span className="chip text-brass">Only {item.stock} left</span>}
            {item.allergens.length > 0 && (
              <span className="text-[0.82rem] text-taupe">Contains {item.allergens.join(", ")}</span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Which section is under the sticky bar, for the underline in the section nav. */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const onScroll = () => {
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < 200) current = id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ids.join("|")]);
  return active;
}
