import { useEffect, useRef, useState } from "react";
import type { Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * A street map in the site's colours. MapLibre with OpenFreeMap tiles: open
 * data, no API key. Loaded only in the browser, and only when the map is used.
 */
const STYLE = "https://tiles.openfreemap.org/styles/positron";

export interface Pin {
  id: string;
  lat: number;
  lng: number;
  kind: "restaurant" | "home" | "driver";
  label?: string;
}

export function MapView({
  pins,
  className = "",
  onPick,
  fit = true,
  interactive = true,
  ariaLabel,
}: {
  pins: Pin[];
  className?: string;
  /** Tap the map to choose a point (used for the delivery address). */
  onPick?: (pos: { lat: number; lng: number }) => void;
  /** Keep every pin in view as they move. */
  fit?: boolean;
  interactive?: boolean;
  ariaLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import("maplibre-gl")
      .then((ml) => {
        if (cancelled || !box.current) return;
        lib.current = ml;
        const first = pins[0];
        const m = new ml.Map({
          container: box.current,
          style: STYLE,
          center: first ? [first.lng, first.lat] : [-2.5966, 51.4497],
          zoom: 14,
          attributionControl: { compact: true },
          interactive,
          cooperativeGestures: interactive,
        });
        box.current.dataset.map = "created";
        m.on("styledata", () => box.current && (box.current.dataset.map = "style"));
        m.on("error", (e) => {
          if (box.current) box.current.dataset.mapError = String((e as { error?: Error }).error?.message ?? e.type);
          if (!m.isStyleLoaded()) setFailed(true);
        });
        m.on("load", () => {
          if (cancelled) return;
          if (box.current) box.current.dataset.map = "loaded";
          tint(m);
          setReady(true);
        });
        m.on("click", (e) => pick.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
        if (interactive) m.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
        map.current = m;
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      markers.current.clear();
    };
    // The map is created once; pins update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml || !ready) return;
    const seen = new Set<string>();
    for (const p of pins) {
      seen.add(p.id);
      let marker = markers.current.get(p.id);
      if (!marker) {
        marker = new ml.Marker({ element: pinElement(p) }).setLngLat([p.lng, p.lat]).addTo(m);
        markers.current.set(p.id, marker);
      } else {
        marker.setLngLat([p.lng, p.lat]);
      }
    }
    for (const [id, marker] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    if (fit && pins.length > 1) {
      const b = new ml.LngLatBounds();
      for (const p of pins) b.extend([p.lng, p.lat]);
      m.fitBounds(b, { padding: 70, maxZoom: 15.5, duration: 900 });
    } else if (pins[0]) {
      m.easeTo({ center: [pins[0].lng, pins[0].lat], duration: 700 });
    }
  }, [pins, ready, fit]);

  return (
    <div className={`relative overflow-hidden bg-linen ${className}`} role="region" aria-label={ariaLabel}>
      {/* Inline, because MapLibre's stylesheet sets its container to position: relative and would collapse it. */}
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
      {failed && (
        <p className="absolute inset-0 grid place-items-center px-6 text-center text-umber">
          The map could not load. Your order still works without it.
        </p>
      )}
    </div>
  );
}

/** Warm the grey basemap towards the site's ivory, green and brass. */
function tint(m: MlMap) {
  const style = m.getStyle();
  for (const layer of style.layers ?? []) {
    try {
      if (layer.type === "background") m.setPaintProperty(layer.id, "background-color", "#efe9dd");
      if (layer.type === "fill" && /water/.test(layer.id)) m.setPaintProperty(layer.id, "fill-color", "#cdd6cf");
      if (layer.type === "fill" && /park|grass|wood|landcover/.test(layer.id)) m.setPaintProperty(layer.id, "fill-color", "#dfe2d2");
      if (layer.type === "fill" && /building/.test(layer.id)) m.setPaintProperty(layer.id, "fill-color", "#e4ddcf");
      if (layer.type === "line" && /road|highway|street/.test(layer.id)) m.setPaintProperty(layer.id, "line-color", "#ffffff");
    } catch {
      // A layer without that property: leave it.
    }
  }
}

function pinElement(p: Pin): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-label", p.label ?? p.kind);
  el.className = `map-pin map-pin-${p.kind}`;
  const span = (cls: string, text?: string) => {
    const s = document.createElement("span");
    s.className = cls;
    if (text) s.textContent = text;
    el.appendChild(s);
  };
  if (p.kind === "driver") span("map-pin-pulse");
  span("map-pin-dot");
  if (p.label && p.kind !== "driver") span("map-pin-label", p.label);
  return el;
}
