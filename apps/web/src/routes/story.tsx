import { Link, createFileRoute } from "@tanstack/react-router";
import { useReveal } from "../lib/motion";
import { SITE } from "../lib/site";
import { SiteFooter, SiteHeader } from "../components/brand";
import { DishPhoto } from "../components/dishes";
import { KitchenFilm } from "../components/landing";
import { Contours, Paper } from "../components/shaders";

export const Route = createFileRoute("/story")({
  head: () => ({
    meta: [
      { title: "Our story · PassPlate" },
      { name: "description", content: "An open kitchen on Wharf Street with a wood fire, a pasta bench and a menu led by the market." },
    ],
  }),
  component: StoryPage,
});

const CHAPTERS = [
  {
    n: "I",
    title: "The fire",
    photo: "/media/dish-flatbread.jpg",
    body: [
      "Everything starts with the oven. It is lit with oak at noon and takes two hours to come up to heat. By the time the first lunch tables sit down, the floor of it is hot enough to blister a flatbread in ninety seconds.",
      "Steaks and whole fish go over charcoal raked out from the same fire. It is the slowest way to run a kitchen and the only one we want.",
    ],
  },
  {
    n: "II",
    title: "The pasta bench",
    photo: "/media/dish-tagliatelle.jpg",
    body: [
      "Every afternoon one cook does nothing but make pasta: eggs, flour, a long wooden board and a rolling pin. Tagliatelle, pappardelle and ravioli are cut to order, so nothing sits.",
      "If you sit at the counter at four o'clock, you will see it happen.",
    ],
  },
  {
    n: "III",
    title: "The market",
    photo: "/media/dish-burrata.jpg",
    body: [
      "The fish comes off the morning boat and the vegetables from two farms an hour away. When something runs out, it comes off the menu, and something else goes on.",
      "That is why the menu you read online might be a dish or two different from the one on your table.",
    ],
  },
  {
    n: "IV",
    title: "The pass",
    photo: "/media/dish-scallops.jpg",
    body: [
      "The pass is the counter between the kitchen and the room, where every plate stops before it goes out. The head chef checks each one there: heat, seasoning, how it looks. Then it is yours.",
      "We named the restaurant after it. Pass, and plate.",
    ],
  },
];

function StoryPage() {
  const page = useReveal<HTMLDivElement>();
  return (
    <div ref={page} className="overflow-x-clip">
      <SiteHeader />

      <header className="relative isolate">
        <Paper className="absolute inset-0 -z-10" tone="linen" />
        <div className="mx-auto grid max-w-[1320px] gap-12 px-5 pt-20 pb-20 md:grid-cols-[6fr_5fr] md:px-10 md:pt-28">
          <div className="flex flex-col justify-end">
            <p className="eyebrow fade-up text-brass">Our story · Since {SITE.since}</p>
            <span className="rule fade-up mt-5" aria-hidden="true" />
            <h1 className="display mt-7 text-[clamp(3rem,5.6vw,5.4rem)]">
              <span className="line-in" style={{ ["--delay" as string]: "100ms" }}>
                A kitchen with
              </span>
              <span className="line-in" style={{ ["--delay" as string]: "240ms" }}>
                no wall around it.
              </span>
            </h1>
            <p className="fade-up mt-8 max-w-lg text-lg leading-relaxed text-umber" style={{ ["--delay" as string]: "500ms" }}>
              PassPlate opened on Wharf Street in {SITE.since} with one idea: put the kitchen in the middle of the room
              and cook everything you can see from your seat.
            </p>
          </div>
          <div className="fade-up aspect-[4/5] max-h-[78svh] w-full" style={{ ["--delay" as string]: "300ms" }}>
            <KitchenFilm />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1320px] px-5 md:px-10">
        {CHAPTERS.map((c, i) => (
          <section key={c.n} className="grid items-center gap-10 border-t border-espresso/12 py-20 md:grid-cols-2 md:gap-20 md:py-28">
            <div className={`reveal ${i % 2 ? "md:order-2" : ""}`}>
              <DishPhoto src={c.photo} alt="" className="aspect-[5/6] w-full" />
            </div>
            <div className="reveal" style={{ ["--delay" as string]: "120ms" }}>
              <p className="eyebrow text-brass">Chapter {i + 1}</p>
              <span className="rule mt-5" aria-hidden="true" />
              <h2 className="display mt-6 text-[clamp(2.6rem,5vw,4.6rem)]">{c.title}</h2>
              {c.body.map((p) => (
                <p key={p.slice(0, 20)} className="mt-6 max-w-lg text-lg leading-relaxed text-umber">
                  {p}
                </p>
              ))}
            </div>
          </section>
        ))}
      </main>

      <section className="relative isolate overflow-hidden bg-espresso text-cream">
        <Contours className="absolute inset-0 -z-10 size-full text-cream/[0.08]" seed={11} />
        <div className="reveal mx-auto max-w-[1100px] px-5 py-32 text-center md:py-44">
          <p className="display text-[clamp(2.2rem,4.8vw,4.2rem)]">
            “Cook it over fire, make it by hand, and check every plate at the pass.”
          </p>
          <span className="rule mx-auto mt-10" aria-hidden="true" />
          <p className="eyebrow mt-6 text-gilt">The only rule in the kitchen</p>
          <div className="mt-12 flex flex-wrap justify-center gap-3">
            <Link to="/menu" className="cta cta-light px-7 py-4">
              <span>See the menu</span>
            </Link>
            <Link to="/visit" className="cta cta-outline-light px-7 py-4">
              <span>Plan a visit</span>
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
