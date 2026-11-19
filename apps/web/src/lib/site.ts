/** The restaurant this site belongs to. One place to change it. */
export const SITE = {
  name: "PassPlate",
  slug: "passplate",
  street: "14 Wharf Street",
  city: "Bristol BS1 4RN",
  phone: "0117 496 0123",
  phoneHref: "tel:+441174960123",
  since: "2019",
  hours: [
    { days: "Monday", time: "Closed" },
    { days: "Tuesday to Thursday", time: "12:00 to 22:30" },
    { days: "Friday and Saturday", time: "12:00 to 23:30" },
    { days: "Sunday", time: "12:00 to 21:00" },
  ],
  kitchenNote: "The kitchen takes last orders 45 minutes before closing.",
  /** Where the restaurant is, for the delivery map. */
  coords: { lat: 51.4497, lng: -2.5966 },
} as const;

export const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${SITE.street}, ${SITE.city}`)}`;

/** Hero films in the order they play. Fetched by `bun run media`. */
export const FILMS = [
  "The room",
  "The wok",
  "Scallops",
  "The pan",
  "The pass",
  "Pasta",
  "Coals",
  "The oven",
  "Flambé",
  "Seasoning",
  "Flame",
  "Searing",
  "The line",
  "The plate",
].map((scene, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { scene, src: `/media/film-${n}.mp4`, small: `/media/film-${n}-sm.mp4` };
});
