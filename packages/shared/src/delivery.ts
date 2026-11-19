import { z } from "zod";

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
  lat: number;
  lng: number;
  at: string;
}
