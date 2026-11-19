import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { SITE, mapsHref } from "../lib/site";
import { useAccount } from "../lib/account";
import { Grain } from "./shaders";

/**
 * Wordmark: widely spaced capitals, like a name cut into a brass plate.
 * "Pass" is the counter where finished plates leave the kitchen.
 */
export function Logo({
  size = "md",
  link = true,
  tone = "dark",
}: {
  size?: "sm" | "md" | "lg" | "xl";
  link?: boolean;
  tone?: "dark" | "light";
}) {
  const text = {
    sm: "text-base tracking-[0.3em]",
    md: "text-[1.3rem] tracking-[0.32em]",
    lg: "text-4xl tracking-[0.3em]",
    xl: "text-[clamp(2.6rem,10.5vw,10rem)] tracking-[0.14em]",
  }[size];
  const mark = (
    <span
      className={`inline-block font-serif leading-none uppercase ${text} ${
        tone === "light" ? "text-cream" : "text-espresso"
      }`}
      style={{ marginRight: "-0.3em" }}
    >
      PassPlate
    </span>
  );
  if (!link) return mark;
  return (
    <Link to="/" aria-label={`${SITE.name} home`} className="inline-flex">
      {mark}
    </Link>
  );
}

const NAV = [
  { to: "/menu", label: "Menu" },
  { to: "/book", label: "Book" },
  { to: "/story", label: "Our story" },
  { to: "/visit", label: "Visit" },
] as const;

/** Top bar. `over` sits transparently over a film and turns solid once you scroll. */
export function SiteHeader({ over = false }: { over?: boolean }) {
  const [scrolled, setScrolled] = useState(!over);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!over) return;
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [over]);
  const light = over && !scrolled && !open;
  const { user, ready } = useAccount();
  const accountLabel = !ready ? "" : user ? user.name.split(" ")[0] : "Sign in";

  return (
    <header
      className={`${over ? "fixed" : "sticky"} inset-x-0 top-0 z-40 transition-[background-color,border-color,color] duration-500 ${
        light ? "border-b border-cream/15 bg-transparent text-cream" : "border-b border-espresso/12 bg-cream/92 text-espresso backdrop-blur-md"
      }`}
    >
      <nav
        className="mx-auto flex h-[76px] max-w-[1440px] items-center gap-6 px-5 md:grid md:grid-cols-[1fr_auto_1fr] md:gap-10 md:px-10"
        aria-label="Main"
      >
        <div className="hidden items-center gap-9 md:flex">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="eyebrow draw" activeProps={{ "aria-current": "page" }}>
              {n.label}
            </Link>
          ))}
        </div>
        <Logo tone={light ? "light" : "dark"} />
        <div className="ml-auto flex items-center gap-8 md:ml-0 md:justify-self-end">
          <Link
            to={user && user.role !== "customer" ? "/staff" : "/account"}
            className="eyebrow draw hidden min-w-[4.5rem] text-right md:inline"
            activeProps={{ "aria-current": "page" }}
          >
            {accountLabel}
          </Link>
          <Link
            to="/r/$slug"
            params={{ slug: SITE.slug }}
            className={`cta px-5 py-3 ${light ? "cta-outline-light" : "cta-dark"}`}
          >
            <span>Order</span>
          </Link>
        </div>
        <button
          type="button"
          className="-mr-2 grid size-10 place-items-center md:hidden"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="relative block h-3 w-6" aria-hidden="true">
            <span className={`absolute inset-x-0 top-0 h-px bg-current transition-transform duration-300 ${open ? "translate-y-1.5 rotate-45" : ""}`} />
            <span className={`absolute inset-x-0 bottom-0 h-px bg-current transition-transform duration-300 ${open ? "-translate-y-1.5 -rotate-45" : ""}`} />
          </span>
        </button>
      </nav>
      {open && (
        <div className="fade-in border-t border-espresso/12 px-5 pt-4 pb-8 md:hidden">
          {NAV.map((n, i) => (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setOpen(false)}
              className="fade-up block border-b border-espresso/12 py-4 font-serif text-4xl"
              style={{ ["--delay" as string]: `${i * 60}ms` }}
            >
              {n.label}
            </Link>
          ))}
          <Link
            to={user && user.role !== "customer" ? "/staff" : "/account"}
            onClick={() => setOpen(false)}
            className="fade-up block border-b border-espresso/12 py-4 font-serif text-4xl"
            style={{ ["--delay" as string]: `${NAV.length * 60}ms` }}
          >
            {user ? "Your account" : "Sign in"}
          </Link>
          <p className="eyebrow mt-6 text-taupe">
            {SITE.street} · {SITE.phone}
          </p>
        </div>
      )}
    </header>
  );
}

/** Centred section heading: a small label, a brass rule, the title. */
export function SectionHead({
  label,
  title,
  intro,
  tone = "dark",
}: {
  label: string;
  title: ReactNode;
  intro?: ReactNode;
  tone?: "dark" | "light";
}) {
  return (
    <div className="reveal mx-auto flex max-w-3xl flex-col items-center text-center">
      <p className={`eyebrow ${tone === "light" ? "text-cream/70" : "text-brass"}`}>{label}</p>
      <span className="rule mt-5" aria-hidden="true" />
      <h2 className="display mt-6 text-[clamp(2.4rem,4.6vw,4.2rem)]">{title}</h2>
      {intro && (
        <p className={`mt-6 max-w-xl text-lg leading-relaxed ${tone === "light" ? "text-cream/75" : "text-umber"}`}>{intro}</p>
      )}
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="relative isolate overflow-hidden bg-espresso text-cream">
      {/* Heat from the grill: a slow grainy gradient of green and brass behind the wordmark. */}
      <Grain className="absolute inset-0 -z-10" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,#17241e_0%,rgb(23_36_30/0.8)_50%,rgb(23_36_30/0.2)_100%)]" />
      <div className="mx-auto max-w-[1440px] px-5 pt-24 pb-10 md:px-10">
        <div className="grid gap-12 md:grid-cols-4">
          <div>
            <p className="eyebrow text-cream/55">Find us</p>
            <p className="mt-4 text-lg leading-relaxed">
              {SITE.street}
              <br />
              {SITE.city}
            </p>
            <a href={mapsHref} target="_blank" rel="noreferrer" className="eyebrow draw mt-4 inline-block text-gilt">
              Directions
            </a>
          </div>
          <div>
            <p className="eyebrow text-cream/55">Hours</p>
            <ul className="mt-4 space-y-1.5">
              {SITE.hours.map((h) => (
                <li key={h.days} className="flex justify-between gap-4 text-cream/85">
                  <span>{h.days}</span>
                  <span className="tabular">{h.time}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="eyebrow text-cream/55">Book a table</p>
            <a href={SITE.phoneHref} className="mt-4 block font-serif text-[1.7rem]">
              {SITE.phone}
            </a>
            <Link to="/book" className="eyebrow draw mt-4 inline-block text-gilt">
              Book online
            </Link>
            <p className="mt-3 text-cream/65">Walk-ins welcome at the bar.</p>
          </div>
          <div className="flex flex-col gap-3">
            <p className="eyebrow text-cream/55">Explore</p>
            <Link to="/menu" className="draw self-start text-lg">
              Menu
            </Link>
            <Link to="/r/$slug" params={{ slug: SITE.slug }} className="draw self-start text-lg">
              Order online
            </Link>
            <Link to="/book" className="draw self-start text-lg">
              Book a table
            </Link>
            <Link to="/account" className="draw self-start text-lg">
              Rewards
            </Link>
            <Link to="/story" className="draw self-start text-lg">
              Our story
            </Link>
            <Link to="/visit" className="draw self-start text-lg">
              Visit
            </Link>
          </div>
        </div>
        <div className="mt-24 text-center">
          <Logo size="xl" link={false} tone="light" />
        </div>
        <div className="mt-8 flex flex-col gap-3 border-t border-cream/20 pt-6 text-cream/55 md:flex-row md:justify-between">
          <p className="eyebrow">Wood fire · Fresh pasta · Since {SITE.since}</p>
          <Link to="/staff" className="eyebrow draw self-start">
            Staff
          </Link>
        </div>
      </div>
    </footer>
  );
}
