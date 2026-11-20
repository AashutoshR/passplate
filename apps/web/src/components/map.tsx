import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * FR-20: one map component, two providers behind it.
 *
 * Google Maps when VITE_GOOGLE_MAPS_KEY is set. If its script fails to load,
 * the key is refused or the quota runs out (Google calls gm_authFailure), or
 * it does not answer in time, the same map switches to MapLibre with
 * OpenFreeMap tiles (NFR-21): open data, no key, nothing for the guest to do.
 * Either script loads only on pages that show a map (NFR-20).
 */
const STYLE = "https://tiles.openfreemap.org/styles/positron";
const GOOGLE_KEY: string | undefined = import.meta.env.VITE_GOOGLE_MAPS_KEY || undefined;
const GOOGLE_MAP_ID: string = import.meta.env.VITE_GOOGLE_MAP_ID || "DEMO_MAP_ID";
const FALLBACK_KEY = "pass:maps-fallback";
/** Room round the edges for pin labels and anything laid over the map. */
const PAD = { top: 120, right: 70, bottom: 70, left: 70 };

export interface Pin {
  id: string;
  lat: number;
  lng: number;
  kind: "restaurant" | "home" | "driver" | "waiting" | "done";
  label?: string;
  /** Called when the pin is tapped (the dispatch map selects with it). */
  onClick?: () => void;
  selected?: boolean;
}

export interface Line {
  id: string;
  points: { lat: number; lng: number }[];
  /** route: the road route. planned: a straight guide where there is no route. */
  kind: "route" | "planned";
}

interface Props {
  pins: Pin[];
  lines?: Line[];
  className?: string;
  /** Tap the map to choose a point (used for the delivery address). */
  onPick?: (pos: { lat: number; lng: number }) => void;
  /** Keep every pin in view as they move. */
  fit?: boolean;
  interactive?: boolean;
  ariaLabel: string;
}

export type MapProvider = "google" | "maplibre";

function startingProvider(): MapProvider {
  if (!GOOGLE_KEY) return "maplibre";
  try {
    if (sessionStorage.getItem(FALLBACK_KEY)) return "maplibre";
  } catch {
    // Storage blocked: try Google.
  }
  return "google";
}

export function MapView(props: Props) {
  const [provider, setProvider] = useState<MapProvider>(() => (typeof window === "undefined" ? "maplibre" : startingProvider()));
  const fallBack = (why: string) => {
    console.warn(`Google Maps unavailable (${why}); using MapLibre.`);
    try {
      sessionStorage.setItem(FALLBACK_KEY, why);
    } catch {
      // Fine: it only saves trying Google again on the next page.
    }
    setProvider("maplibre");
  };
  return (
    <div
      className={`relative overflow-hidden bg-linen ${props.className ?? ""}`}
      role="region"
      aria-label={props.ariaLabel}
      data-map-provider={provider}
    >
      {provider === "google" ? <GoogleMap key="g" {...props} onFail={fallBack} /> : <LibreMap key="m" {...props} />}
    </div>
  );
}

/* ------------------------------------------------------------------ MapLibre */

function LibreMap({ pins, lines = [], onPick, fit = true, interactive = true }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef(new Map<string, { marker: Marker; pin: Pin }>());
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const fitted = useRef(false);

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
          if (box.current) {
            box.current.dataset.map = "loaded";
            // Keep the credit as the small (i) button: opened, it covers a phone-sized map.
            const credit = box.current.querySelector(".maplibregl-ctrl-attrib");
            credit?.classList.remove("maplibregl-compact-show");
            credit?.removeAttribute("open");
          }
          tint(m);
          m.addSource("lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({
            id: "lines-route",
            type: "line",
            source: "lines",
            filter: ["==", ["get", "kind"], "route"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#1f5a3d", "line-width": 4, "line-opacity": 0.85 },
          });
          m.addLayer({
            id: "lines-planned",
            type: "line",
            source: "lines",
            filter: ["==", ["get", "kind"], "planned"],
            layout: { "line-cap": "round" },
            paint: { "line-color": "#a9844f", "line-width": 2.5, "line-dasharray": [2, 2] },
          });
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
      const had = markers.current.get(p.id);
      if (!had || pinKey(had.pin) !== pinKey(p)) {
        had?.marker.remove();
        const marker = new ml.Marker({ element: pinElement(p) }).setLngLat([p.lng, p.lat]).addTo(m);
        markers.current.set(p.id, { marker, pin: p });
      } else {
        had.marker.setLngLat([p.lng, p.lat]);
        had.pin = p;
      }
    }
    for (const [id, { marker }] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    (m.getSource("lines") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: lines
        .filter((l) => l.points.length > 1)
        .map((l) => ({
          type: "Feature",
          properties: { kind: l.kind },
          geometry: { type: "LineString", coordinates: l.points.map((p) => [p.lng, p.lat]) },
        })),
    });
    if ((fit || !fitted.current) && pins.length > 1) {
      const b = new ml.LngLatBounds();
      for (const p of pins) b.extend([p.lng, p.lat]);
      m.fitBounds(b, { padding: PAD, maxZoom: 15.5, duration: fitted.current ? 900 : 0 });
      fitted.current = true;
    } else if (fit && pins[0]) {
      m.easeTo({ center: [pins[0].lng, pins[0].lat], duration: 700 });
    }
  }, [pins, lines, ready, fit]);

  return (
    <>
      {/* Inline, because MapLibre's stylesheet sets its container to position: relative and would collapse it. */}
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
      {failed && (
        <p className="absolute inset-0 grid place-items-center px-6 text-center text-umber">
          The map could not load. Your order still works without it.
        </p>
      )}
    </>
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

/* ------------------------------------------------------------------ Google */

// The Maps JavaScript API has no types in this project; only these few calls are used.
/* eslint-disable @typescript-eslint/no-explicit-any */
type G = any;
let googleLoad: Promise<G> | null = null;
const googleFailures = new Set<(why: string) => void>();

function loadGoogle(): Promise<G> {
  googleLoad ??= new Promise<G>((resolve, reject) => {
    const w = window as G;
    if (w.google?.maps?.importLibrary) return resolve(w.google);
    // Google calls this when the key is refused or the quota is used up.
    w.gm_authFailure = () => {
      for (const f of googleFailures) f("key refused or quota reached");
    };
    w.__passGoogleReady = () => resolve(w.google);
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_KEY ?? "")}&v=weekly&loading=async&callback=__passGoogleReady`;
    s.async = true;
    s.onerror = () => reject(new Error("script failed to load"));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("timed out")), 10_000);
  });
  return googleLoad;
}

function GoogleMap({ pins, lines = [], onPick, fit = true, interactive = true, onFail }: Props & { onFail: (why: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const state = useRef<{ g: G; map: G; Marker: G; markers: Map<string, { m: G; pin: Pin }>; lines: Map<string, G> } | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [ready, setReady] = useState(false);
  const fitted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fail = (why: string) => !cancelled && onFail(why);
    googleFailures.add(fail);
    loadGoogle()
      .then(async (g) => {
        const [{ Map }, { AdvancedMarkerElement }] = await Promise.all([g.maps.importLibrary("maps"), g.maps.importLibrary("marker")]);
        if (cancelled || !box.current) return;
        const first = pins[0];
        const map = new Map(box.current, {
          center: first ? { lat: first.lat, lng: first.lng } : { lat: 51.4497, lng: -2.5966 },
          zoom: 14,
          mapId: GOOGLE_MAP_ID,
          disableDefaultUI: true,
          zoomControl: interactive,
          clickableIcons: false,
          gestureHandling: interactive ? "cooperative" : "none",
        });
        map.addListener("click", (e: G) => e.latLng && pick.current?.({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
        state.current = { g, map, Marker: AdvancedMarkerElement, markers: new globalThis.Map(), lines: new globalThis.Map() };
        box.current.dataset.map = "loaded";
        setReady(true);
      })
      .catch((err: Error) => fail(err.message));
    return () => {
      cancelled = true;
      googleFailures.delete(fail);
      const s = state.current;
      if (s) {
        for (const { m } of s.markers.values()) m.map = null;
        for (const l of s.lines.values()) l.setMap(null);
      }
      state.current = null;
    };
    // Created once; pins update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const s = state.current;
    if (!s || !ready) return;
    const seen = new Set<string>();
    for (const p of pins) {
      seen.add(p.id);
      const had = s.markers.get(p.id);
      if (!had || pinKey(had.pin) !== pinKey(p)) {
        if (had) had.m.map = null;
        const m = new s.Marker({ map: s.map, position: { lat: p.lat, lng: p.lng }, content: pinElement(p), title: p.label ?? p.kind });
        s.markers.set(p.id, { m, pin: p });
      } else {
        had.m.position = { lat: p.lat, lng: p.lng };
        had.pin = p;
      }
    }
    for (const [id, { m }] of s.markers) {
      if (!seen.has(id)) {
        m.map = null;
        s.markers.delete(id);
      }
    }
    const wanted = new Set(lines.map((l) => l.id));
    for (const [id, l] of s.lines) {
      if (!wanted.has(id)) {
        l.setMap(null);
        s.lines.delete(id);
      }
    }
    for (const l of lines) {
      const path = l.points.map((p) => ({ lat: p.lat, lng: p.lng }));
      const existing = s.lines.get(l.id);
      if (existing) existing.setPath(path);
      else
        s.lines.set(
          l.id,
          new s.g.maps.Polyline({
            map: s.map,
            path,
            strokeColor: l.kind === "route" ? "#1f5a3d" : "#a9844f",
            strokeOpacity: l.kind === "route" ? 0.85 : 0,
            strokeWeight: l.kind === "route" ? 4 : 2.5,
            // A dashed guide where there is no road route.
            icons:
              l.kind === "planned"
                ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: "#a9844f", scale: 2.5 }, offset: "0", repeat: "12px" }]
                : undefined,
          }),
        );
    }
    if ((fit || !fitted.current) && pins.length > 1) {
      const b = new s.g.maps.LatLngBounds();
      for (const p of pins) b.extend({ lat: p.lat, lng: p.lng });
      s.map.fitBounds(b, PAD);
      if (s.map.getZoom() > 15.5) s.map.setZoom(15.5);
      fitted.current = true;
    } else if (fit && pins[0]) {
      s.map.panTo({ lat: pins[0].lat, lng: pins[0].lng });
    }
  }, [pins, lines, ready, fit]);

  return <div ref={box} style={{ position: "absolute", inset: 0 }} />;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ Pins */

const pinKey = (p: Pin) => `${p.kind}|${p.label ?? ""}|${p.selected ? 1 : 0}|${p.onClick ? 1 : 0}`;

function pinElement(p: Pin): HTMLElement {
  const el = document.createElement(p.onClick ? "button" : "div");
  el.setAttribute("aria-label", p.label ?? p.kind);
  el.className = `map-pin map-pin-${p.kind}${p.selected ? " map-pin-selected" : ""}`;
  if (p.onClick) {
    (el as HTMLButtonElement).type = "button";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      p.onClick?.();
    });
  }
  const span = (cls: string, text?: string) => {
    const s = document.createElement("span");
    s.className = cls;
    if (text) s.textContent = text;
    el.appendChild(s);
  };
  if (p.kind === "driver") span("map-pin-pulse");
  span("map-pin-dot");
  if (p.label) span("map-pin-label", p.label);
  return el;
}
