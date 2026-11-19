import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** The tall kitchen film used beside the story text. Pausable with one quiet button. */
export function KitchenFilm({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (prefersReducedMotion()) {
      v.pause();
      setPlaying(false);
    }
  }, []);
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().then(() => setPlaying(true));
    else {
      v.pause();
      setPlaying(false);
    }
  };
  return (
    <div className={`relative size-full overflow-hidden bg-cocoa ${className}`}>
      <video
        ref={ref}
        className="absolute inset-0 size-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-label="A chef at work on the line"
      >
        <source src="/media/kitchen-640.mp4" type="video/mp4" media="(max-width: 640px)" />
        <source src="/media/kitchen-960.mp4" type="video/mp4" />
      </video>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause the film" : "Play the film"}
        className="absolute right-4 bottom-4 grid size-9 place-items-center rounded-full border border-cream/50 text-cream/85 transition-colors hover:border-cream hover:text-cream"
      >
        {playing ? (
          <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
            <rect width="3" height="10" fill="currentColor" />
            <rect x="6" width="3" height="10" fill="currentColor" />
          </svg>
        ) : (
          <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
            <path d="M0 0L9 5L0 10Z" fill="currentColor" />
          </svg>
        )}
      </button>
    </div>
  );
}
