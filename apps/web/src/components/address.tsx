import { useState } from "react";
import {
  DELIVERY_RADIUS_KM,
  deliveryFee,
  distanceKm,
  rideMinutes,
  type DeliveryAddress,
} from "@pass/shared";
import { MapView } from "./map";

/**
 * Where to deliver: a UK postcode finds the spot (postcodes.io, open data, no
 * key), the street line is typed, and a tap on the map fine-tunes the pin.
 */
export function AddressPicker({
  restaurant,
  value,
  onChange,
  money,
}: {
  restaurant: { lat: number; lng: number };
  value: Partial<DeliveryAddress>;
  onChange: (v: Partial<DeliveryAddress>) => void;
  money: (m: number) => string;
}) {
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasPin = typeof value.lat === "number" && typeof value.lng === "number";
  const km = hasPin ? distanceKm(restaurant, { lat: value.lat!, lng: value.lng! }) : null;
  const tooFar = km !== null && km > DELIVERY_RADIUS_KM;

  async function find() {
    const pc = (value.postcode ?? "").trim();
    if (pc.length < 5) {
      setError("Enter a full postcode, like BS1 4LH.");
      return;
    }
    setLooking(true);
    setError(null);
    try {
      const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, {
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json()) as { status: number; result?: { latitude: number; longitude: number; postcode: string } };
      if (!res.ok || !data.result) throw new Error("not found");
      onChange({ ...value, postcode: data.result.postcode, lat: data.result.latitude, lng: data.result.longitude });
    } catch {
      setError("We could not find that postcode. Check it, or tap the map where you are.");
    } finally {
      setLooking(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Postcode</span>
          <input
            value={value.postcode ?? ""}
            onChange={(e) => onChange({ ...value, postcode: e.target.value.toUpperCase().slice(0, 10) })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void find();
              }
            }}
            autoComplete="postal-code"
            placeholder="BS1 4LH"
            className="w-full border border-espresso/25 bg-cream px-4 py-3.5 text-lg uppercase outline-none placeholder:text-taupe placeholder:normal-case focus:border-espresso"
          />
        </label>
        <button type="button" onClick={find} disabled={looking} className="cta cta-outline self-end px-5 py-[0.95rem]">
          <span>{looking ? "Finding…" : "Find"}</span>
        </button>
      </div>
      <label className="block">
        <span className="mb-2 block text-sm font-medium">House number and street</span>
        <input
          value={value.line1 ?? ""}
          onChange={(e) => onChange({ ...value, line1: e.target.value.slice(0, 120) })}
          autoComplete="address-line1"
          placeholder="Flat 2, 18 Queen Square"
          className="w-full border border-espresso/25 bg-cream px-4 py-3.5 text-lg outline-none placeholder:text-taupe focus:border-espresso"
        />
      </label>

      <MapView
        ariaLabel="Delivery address on the map. Tap to move the pin."
        className="aspect-[16/10] w-full"
        fit
        pins={[
          { id: "restaurant", kind: "restaurant", lat: restaurant.lat, lng: restaurant.lng, label: "PassPlate" },
          ...(hasPin ? [{ id: "home", kind: "home" as const, lat: value.lat!, lng: value.lng!, label: "You" }] : []),
        ]}
        onPick={(p) => onChange({ ...value, lat: p.lat, lng: p.lng })}
      />
      {error && <p className="text-sm text-espresso">{error}</p>}
      {km !== null && (
        <p className={`text-sm ${tooFar ? "text-espresso" : "text-umber"}`}>
          {tooFar
            ? `That is ${km.toFixed(1)} km away. We deliver within ${DELIVERY_RADIUS_KM} km; you could collect instead.`
            : `${km.toFixed(1)} km away · about ${rideMinutes(km)} minutes by bike once it leaves the kitchen · delivery ${money(deliveryFee(km))}`}
        </p>
      )}
      <label className="block">
        <span className="mb-2 block text-sm font-medium">For the driver (optional)</span>
        <input
          value={value.instructions ?? ""}
          onChange={(e) => onChange({ ...value, instructions: e.target.value.slice(0, 200) })}
          placeholder="Ring the top bell"
          className="w-full border border-espresso/25 bg-cream px-4 py-3.5 outline-none placeholder:text-taupe focus:border-espresso"
        />
      </label>
    </div>
  );
}
