import { z } from "zod";
import type { TicketView } from "./views";

/** Delivery: a radius around the restaurant, a fee by distance, a minimum order. */
export const DELIVERY_RADIUS_KM = 5;
export const DELIVERY_MIN_ORDER_MINOR = 1500;

export function deliveryFee(km: number): number {
  if (km <= 2) return 250;
  if (km <= 3.5) return 350;
  return 495;
}

/** Straight-line distance in kilometres. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Rough minutes for a rider in town: 18 km/h plus a couple of minutes at each end. */
export function rideMinutes(km: number): number {
  return Math.max(4, Math.round((km / 18) * 60 + 3));
}

export const DeliveryAddressSchema = z.object({
  line1: z.string().trim().min(3, "Add a street address").max(120),
  postcode: z.string().trim().min(3).max(12),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  instructions: z.string().trim().max(200).optional(),
});
export type DeliveryAddress = z.infer<typeof DeliveryAddressSchema>;

export const DriverLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export interface DriverLocation {
  orderId: string;
  driverId: string;
  lat: number;
  lng: number;
  at: string;
  /** When the food should arrive, from the route (or a straight line if there is none). */
  etaAt: string | null;
  /** Within ARRIVING_METRES of the door (FR-18). */
  arriving: boolean;
}

/** FR-18: the guest is told the driver is nearly there inside this distance. */
export const ARRIVING_METRES = 200;
/** NFR-20: the ETA is worked out again at most this often while the driver moves. */
export const ETA_EVERY_MS = 30_000;

/**
 * Minutes still to go. With a road route, the straight distance left is
 * scaled by how much longer the road is than the crow flies, at the route's
 * own speed. Without one, a straight line at bike speed.
 */
export function etaMinutes(
  remainingKm: number,
  route: { distanceM: number; durationS: number; straightKm: number } | null,
): number {
  if (route && route.durationS > 0 && route.distanceM > 0 && route.straightKm > 0.05) {
    const roadKm = remainingKm * (route.distanceM / 1000 / route.straightKm);
    const kmPerMin = route.distanceM / 1000 / (route.durationS / 60);
    return Math.max(1, Math.round(roadKm / kmPerMin));
  }
  return Math.max(1, Math.round((remainingKm / 18) * 60 + 1));
}

/** How the driver left the food (proof of delivery). */
export const DELIVERY_PROOFS = ["handed_over", "left_at_door", "neighbour", "safe_place"] as const;
export type DeliveryProof = (typeof DELIVERY_PROOFS)[number];
export const PROOF_LABEL: Record<DeliveryProof, string> = {
  handed_over: "Handed to the customer",
  left_at_door: "Left at the door",
  neighbour: "Left with a neighbour",
  safe_place: "Left in a safe place",
};

export const DeliveredSchema = z.object({
  proof: z.enum(DELIVERY_PROOFS),
  note: z.string().trim().max(200).optional(),
  /** Where the phone was when the driver tapped Delivered, if it could tell. */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const AssignSchema = z.object({ driverId: z.string().uuid() });
export const ShiftSchema = z.object({ on: z.boolean() });

/** A driver as the dispatcher sees them. */
export interface DispatchDriver {
  id: string;
  name: string;
  onShift: boolean;
  /** Last known position: live while on a delivery, otherwise where the last one ended. */
  position: { lat: number; lng: number; at: string } | null;
  /** Orders with this driver now, and orders assigned and waiting to be collected. */
  carrying: string[];
  assigned: string[];
  deliveredToday: number;
  /** Minutes until they could be back at the restaurant: 0 when free and here. */
  backInMinutes: number;
}

export interface DispatchView {
  location: { id: string; name: string; lat: number; lng: number; currency: string; timezone: string };
  /** Paid deliveries not yet out: cooking or ready, with or without a driver assigned. */
  waiting: TicketView[];
  onTheRoad: TicketView[];
  /** Delivered since the start of today, newest first. */
  delivered: TicketView[];
  drivers: DispatchDriver[];
  /** Ids of on-shift drivers, best first, for the next delivery. */
  suggested: string[];
  seq: number;
}

/** Google's encoded polyline format, decoded to points. */
export function decodePolyline(encoded: string): { lat: number; lng: number }[] {
  const out: { lat: number; lng: number }[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

export function encodePolyline(points: { lat: number; lng: number }[]): string {
  let out = "";
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}
