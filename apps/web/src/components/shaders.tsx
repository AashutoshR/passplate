import { useEffect, useMemo, useState } from "react";
import { FlutedGlass, GrainGradient, PaperTexture } from "@paper-design/shaders-react";
import { prefersReducedMotion } from "../lib/motion";

/**
 * Texture layers from Paper Shaders (WebGL). Each one renders a plain CSS
 * fallback on the server and before WebGL is up, so nothing pops or breaks
 * where WebGL is unavailable. Shaders pause themselves when offscreen.
 */
function useClient() {
  const [state, setState] = useState<{ ready: boolean; still: boolean }>({ ready: false, still: false });
  useEffect(() => setState({ ready: true, still: prefersReducedMotion() }), []);
  return state;
}

/** Thermal grain: bottle green and brass moving like heat over coals. */
export function Grain({ className = "" }: { className?: string }) {
  const { ready, still } = useClient();
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ background: "radial-gradient(120% 90% at 80% 110%, #6b5532 0%, #22302a 45%, #17241e 80%)" }}
    >
      {ready && (
        <GrainGradient
          style={{ width: "100%", height: "100%" }}
          colorBack="#17241e"
          colors={["#22302a", "#5e4b2e", "#a9844f", "#17241e"]}
          softness={0.9}
          intensity={0.25}
          noise={0.4}
          shape="corners"
          speed={still ? 0 : 0.35}
        />
      )}
    </div>
  );
}

/** Cream paper with real fibre and the faintest folds. Static. */
export function Paper({ className = "", tone = "cream" }: { className?: string; tone?: "cream" | "linen" }) {
  const { ready } = useClient();
  const back = tone === "cream" ? "#f2ece1" : "#e6e1d6";
  return (
    <div aria-hidden="true" className={className} style={{ background: back }}>
      {ready && (
        <PaperTexture
          style={{ width: "100%", height: "100%" }}
          colorBack={back}
          colorPaper={back}
          colorShadow="#c9c3b4"
          fit="cover"
          speed={0}
          roughness={0.35}
          roughnessSize={0.45}
          fiber={0.35}
          fiberSize={0.4}
          folds={0.18}
          foldSizeX={1}
          foldSizeY={1}
          wrinkles={0.25}
          wrinkleSize={0.6}
          crumples={0}
          drops={0.08}
          seed={12}
          angle={20}
        />
      )}
    </div>
  );
}

/** A photograph seen through ribbed glass, like a restaurant door. */
export function Fluted({ image, className = "" }: { image: string; className?: string }) {
  const { ready } = useClient();
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ backgroundImage: `url(${image})`, backgroundSize: "cover", backgroundPosition: "center", filter: ready ? undefined : "blur(18px)" }}
    >
      {ready && (
        <FlutedGlass
          style={{ width: "100%", height: "100%" }}
          image={image}
          fit="cover"
          colorBack="#00000000"
          colorShadow="#17241e"
          colorHighlight="#f2ece1"
          shape="lines"
          distortionShape="prism"
          size={0.62}
          distortion={0.55}
          shadows={0.3}
          highlights={0.08}
          edges={0.3}
          blur={0.25}
          grainMixer={0.15}
          grainOverlay={0.12}
          angle={0}
          speed={0}
        />
      )}
    </div>
  );
}

/**
 * Contour lines, like a survey map of the street. Drawn once as SVG from a
 * seeded height field, so it costs nothing at runtime.
 */
export function Contours({ className = "", seed = 3, color = "currentColor" }: { className?: string; seed?: number; color?: string }) {
  const paths = useMemo(() => contourPaths(seed), [seed]);
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" fill="none">
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke={color}
          strokeWidth={i % 5 === 0 ? 1.1 : 0.6}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** Marching squares over a smooth sum of hills. Small, deterministic, no dependency. */
function contourPaths(seed: number): string[] {
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const hills = Array.from({ length: 7 }, () => ({ x: rand() * 1200, y: rand() * 800, r: 160 + rand() * 260, h: 0.5 + rand() }));
  const height = (x: number, y: number) =>
    hills.reduce((sum, p) => sum + p.h * Math.exp(-((x - p.x) ** 2 + (y - p.y) ** 2) / (2 * p.r * p.r)), 0);
  const step = 20;
  const cols = 1200 / step + 1;
  const rows = 800 / step + 1;
  const grid: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) grid.push(height(i * step, j * step));
  const at = (i: number, j: number) => grid[j * cols + i]!;
  const out: string[] = [];
  for (let level = 0.12; level < 1.6; level += 0.07) {
    let d = "";
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), e = at(i, j + 1);
        const x = i * step, y = j * step;
        const lerp = (p: number, q: number) => (level - p) / (q - p);
        const pts: [number, number][] = [];
        if ((a < level) !== (b < level)) pts.push([x + step * lerp(a, b), y]);
        if ((b < level) !== (c < level)) pts.push([x + step, y + step * lerp(b, c)]);
        if ((e < level) !== (c < level)) pts.push([x + step * lerp(e, c), y + step]);
        if ((a < level) !== (e < level)) pts.push([x, y + step * lerp(a, e)]);
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const [p, q] = [pts[k]!, pts[k + 1]!];
          d += `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
        }
      }
    }
    if (d) out.push(d);
  }
  return out;
}
