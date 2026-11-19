import { useCallback, useState } from "react";
import { DIETARY_LABELS } from "@pass/shared";

/** A dish photograph that develops into focus. Hides itself if the file is missing. */
export function DishPhoto({
  src,
  alt,
  className = "",
  delay = 0,
  eager = false,
}: {
  src: string | null;
  alt: string;
  className?: string;
  delay?: number;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Cached images can finish before React attaches onLoad.
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);
  if (!src || failed) {
    return <div aria-hidden="true" className={`bg-linen ${className}`} />;
  }
  return (
    <div className={`overflow-hidden bg-linen ${className}`}>
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`develop ${loaded ? "in" : ""} size-full object-cover group-hover:scale-[1.045]`}
        style={{ ["--delay" as string]: `${delay}ms` }}
      />
    </div>
  );
}

const SHORT: Record<string, string> = { v: "V", vg: "VG", gf: "GF", spicy: "Hot" };

export function DietaryMarks({ dietary, className = "" }: { dietary: string[]; className?: string }) {
  if (dietary.length === 0) return null;
  return (
    <span className={`inline-flex gap-1.5 ${className}`}>
      {dietary.map((d) => (
        <abbr
          key={d}
          title={DIETARY_LABELS[d] ?? d}
          className={`chip no-underline ${d === "spicy" ? "text-oxblood" : "text-olive"}`}
        >
          {SHORT[d] ?? d}
        </abbr>
      ))}
    </span>
  );
}
