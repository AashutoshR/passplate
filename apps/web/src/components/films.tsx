import { useCallback, useEffect, useRef, useState } from "react";
import { FILMS } from "../lib/site";
import { prefersReducedMotion } from "../lib/motion";

const SHOT_MS = 6500;
const FADE_MS = 1600;

/**
 * The hero reel: fourteen real kitchen films, each shown for a few seconds
 * and dissolved into the next with a slow drift. No captions, no counter.
 * Only the film on screen and the one after it are ever loaded.
 */
export function useReel() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [small, setSmall] = useState<boolean | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    setSmall(window.matchMedia("(max-width: 900px)").matches);
    if (prefersReducedMotion()) setPlaying(false);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % FILMS.length), SHOT_MS);
    return () => clearTimeout(t);
  }, [playing, index, run]);

  const toggle = useCallback(() => {
    setPlaying((p) => !p);
    setRun((r) => r + 1);
  }, []);

  return { index, playing, small, toggle };
}

export function HeroReel({ reel }: { reel: ReturnType<typeof useReel> }) {
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const { index, playing, small } = reel;
  const next = (index + 1) % FILMS.length;

  useEffect(() => {
    const v = refs.current[index];
    if (!v) return;
    if (playing) {
      v.currentTime = 0;
      void v.play().catch(() => {});
    } else v.pause();
    // Let the previous film finish dissolving before it stops.
    const t = setTimeout(() => {
      refs.current.forEach((other, i) => i !== index && other && !other.paused && other.pause());
    }, FADE_MS + 100);
    return () => clearTimeout(t);
  }, [index, playing, small]);

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden bg-espresso">
      {/* Warm light before the first frame arrives. */}
      <div className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_40%,#2c3a32_0%,#17241e_70%)]" />
      {small !== null &&
        FILMS.map((f, i) => {
          const load = i === index || i === next;
          const active = i === index;
          return (
            <div
              key={f.src}
              className="absolute inset-0 transition-opacity ease-in-out"
              style={{ opacity: active ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
            >
              <video
                ref={(el) => {
                  refs.current[i] = el;
                }}
                className={`absolute inset-0 size-full object-cover ${active && playing ? "drift" : ""}`}
                src={load ? (small ? f.small : f.src) : undefined}
                muted
                loop
                playsInline
                preload={load ? "auto" : "none"}
              />
            </div>
          );
        })}
      {/* Grade: an even veil so centred type reads on every film, deeper at the edges. */}
      <div className="absolute inset-0 bg-[rgb(10_16_13/0.42)]" />
      <div className="absolute inset-0 bg-[radial-gradient(75%_65%_at_50%_55%,transparent_0%,rgb(10_16_13/0.55)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgb(10_16_13/0.5)_0%,transparent_25%,transparent_70%,rgb(10_16_13/0.6)_100%)]" />
    </div>
  );
}

/** The one control: a small pause, for anyone who would rather the picture held still. */
export function ReelPause({ reel }: { reel: ReturnType<typeof useReel> }) {
  const { playing, toggle } = reel;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={playing ? "Pause the film" : "Play the film"}
      className="grid size-9 place-items-center rounded-full border border-cream/35 text-cream/80 transition-colors hover:border-cream hover:text-cream"
    >
      {playing ? (
        <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
          <rect width="2.5" height="10" fill="currentColor" />
          <rect x="5.5" width="2.5" height="10" fill="currentColor" />
        </svg>
      ) : (
        <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
          <path d="M1 0L9 5L1 10Z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}
