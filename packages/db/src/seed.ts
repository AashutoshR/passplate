import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { ALWAYS_OPEN, type OpeningHours } from "@pass/shared";
import type { Db } from "./client";
import {
  diningTables,
  locations,
  menuCategories,
  menuItems,
  modifierGroups,
  modifiers,
  tenants,
  users,
} from "./schema";

/** Development only. Real kitchens sign in with staff accounts from Milestone 4. */
export const DEMO_KITCHEN_CODE = "demo-kitchen";

/**
 * Development accounts, one per role. Test values only: never reuse them
 * anywhere real. The .test domain is reserved and cannot receive mail.
 */
export const DEMO_ACCOUNTS = {
  admin: { email: "admin@passplate.test", password: "passplate-admin", name: "Asha Patel" },
  staff: { email: "floor@passplate.test", password: "passplate-floor", name: "Marco Rossi" },
  driver: { email: "driver@passplate.test", password: "passplate-driver", name: "Dee Okafor" },
  customer: { email: "guest@passplate.test", password: "passplate-guest", name: "Sam Carter" },
} as const;

/** The hours guests can book a table. Monday closed. */
export const BOOKING_HOURS: OpeningHours = {
  tue: [["12:00", "22:30"]],
  wed: [["12:00", "22:30"]],
  thu: [["12:00", "22:30"]],
  fri: [["12:00", "23:30"]],
  sat: [["12:00", "23:30"]],
  sun: [["12:00", "21:00"]],
};

type Shape = "round" | "square" | "rect" | "booth" | "stool";
/**
 * The room, drawn on a 1000 x 640 grid: window booths down the left, the main
 * room in the middle, the kitchen counter on the right and the terrace below it.
 */
const FLOOR: { label: string; seats: number; area: string; shape: Shape; x: number; y: number; w: number; h: number }[] = [
  { label: "Table 1", seats: 4, area: "Window", shape: "booth", x: 40, y: 50, w: 130, h: 96 },
  { label: "Table 2", seats: 4, area: "Window", shape: "booth", x: 40, y: 190, w: 130, h: 96 },
  { label: "Table 3", seats: 4, area: "Window", shape: "booth", x: 40, y: 330, w: 130, h: 96 },
  { label: "Table 4", seats: 4, area: "Window", shape: "booth", x: 40, y: 470, w: 130, h: 96 },
  { label: "Table 5", seats: 2, area: "Main room", shape: "round", x: 250, y: 60, w: 84, h: 84 },
  { label: "Table 6", seats: 2, area: "Main room", shape: "round", x: 380, y: 60, w: 84, h: 84 },
  { label: "Table 7", seats: 4, area: "Main room", shape: "square", x: 510, y: 50, w: 104, h: 104 },
  { label: "Table 8", seats: 4, area: "Main room", shape: "square", x: 250, y: 220, w: 104, h: 104 },
  { label: "Table 9", seats: 4, area: "Main room", shape: "square", x: 400, y: 220, w: 104, h: 104 },
  { label: "Table 10", seats: 6, area: "Main room", shape: "rect", x: 550, y: 220, w: 150, h: 104 },
  { label: "Table 11", seats: 8, area: "Main room", shape: "rect", x: 250, y: 410, w: 240, h: 110 },
  { label: "Table 12", seats: 2, area: "Main room", shape: "round", x: 540, y: 430, w: 84, h: 84 },
  { label: "Table 13", seats: 4, area: "Terrace", shape: "round", x: 770, y: 470, w: 96, h: 96 },
  { label: "Table 14", seats: 4, area: "Terrace", shape: "round", x: 880, y: 470, w: 96, h: 96 },
  { label: "Counter 1", seats: 2, area: "Counter", shape: "stool", x: 760, y: 60, w: 70, h: 64 },
  { label: "Counter 2", seats: 2, area: "Counter", shape: "stool", x: 760, y: 150, w: 70, h: 64 },
  { label: "Counter 3", seats: 2, area: "Counter", shape: "stool", x: 760, y: 240, w: 70, h: 64 },
  { label: "Counter 4", seats: 2, area: "Counter", shape: "stool", x: 760, y: 330, w: 70, h: 64 },
];

let demoHashes: Promise<Record<keyof typeof DEMO_ACCOUNTS, string>> | null = null;
/** Hashed once per process: the seed runs before every test. */
function hashDemoPasswords() {
  demoHashes ??= (async () => {
    const out = {} as Record<keyof typeof DEMO_ACCOUNTS, string>;
    for (const [role, a] of Object.entries(DEMO_ACCOUNTS)) {
      out[role as keyof typeof DEMO_ACCOUNTS] = await Bun.password.hash(a.password, {
        algorithm: "argon2id",
        memoryCost: 19456,
        timeCost: 2,
      });
    }
    return out;
  })();
  return demoHashes;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface SeedItem {
  name: string;
  description?: string;
  price: number;
  allergens?: string[];
  dietary?: string[];
  /** Key of a photo fetched by `bun run media` (apps/web/public/media/dish-<key>.jpg). */
  photo?: string;
  featured?: boolean;
  stock?: number | null;
  groups?: { name: string; min: number; max: number; options: [string, number][] }[];
}

const MENU: { category: string; blurb: string; items: SeedItem[] }[] = [
  {
    category: "Bread and raw",
    blurb: "To start while the fire gets going.",
    items: [
      {
        name: "Sourdough and cultured butter",
        description: "Baked this morning, whipped sea salt butter",
        price: 550,
        allergens: ["gluten", "milk"],
        dietary: ["v"],
        photo: "bread",
        stock: 20,
      },
      {
        name: "Oysters",
        description: "Shallot vinegar, lemon, Tabasco on the side",
        price: 1200,
        allergens: ["molluscs"],
        dietary: ["gf"],
        photo: "oysters",
        stock: 36,
        groups: [{ name: "How many", min: 1, max: 1, options: [["Three", 0], ["Six", 1100]] }],
      },
      {
        name: "Burrata and heritage tomatoes",
        description: "Basil oil, aged balsamic, grilled bread",
        price: 1100,
        allergens: ["milk", "gluten"],
        dietary: ["v"],
        photo: "burrata",
        featured: true,
      },
      {
        name: "Roast beetroot",
        description: "Smoked yoghurt, hazelnut dukkah, sorrel",
        price: 850,
        allergens: ["milk", "nuts"],
        dietary: ["v", "gf"],
        photo: "beetroot",
      },
      { name: "Gordal olives", photo: "olives", description: "Orange, fennel seed, chilli", price: 450, dietary: ["vg", "gf"] },
    ],
  },
  {
    category: "From the oven",
    blurb: "Sourdough bases, blistered in the wood oven.",
    items: [
      { name: "Margherita", photo: "margherita", description: "San Marzano tomato, fior di latte, basil", price: 1100, allergens: ["gluten","milk"], dietary: ["v"] },
      { name: "Nduja, ricotta and hot honey", photo: "nduja-pizza", description: "Calabrian nduja, whipped ricotta, chilli honey", price: 1450, allergens: ["gluten","milk"], dietary: ["spicy"] },
      { name: "Wild mushroom and truffle", photo: "mushroom-pizza", description: "Taleggio, thyme, truffle oil, no tomato", price: 1450, allergens: ["gluten","milk"], dietary: ["v"] },
      { name: "Four cheese", photo: "four-cheese", description: "Mozzarella, gorgonzola, fontina, parmesan, rosemary", price: 1350, allergens: ["gluten","milk"], dietary: ["v"] },
      { name: "Garlic and rosemary flatbread", photo: "garlic-flatbread", description: "To share, with olive oil", price: 650, allergens: ["gluten"], dietary: ["vg"] },
    ],
  },
  {
    category: "Raw and cured",
    blurb: "Cut to order, dressed at the last minute.",
    items: [
      { name: "Beef tartare", photo: "tartare", description: "Hand-cut sirloin, cured yolk, capers, crisp bread", price: 1350, allergens: ["egg","gluten","mustard"] },
      { name: "Tuna crudo", photo: "crudo", description: "Yellowfin tuna, blood orange, chilli, olive oil", price: 1400, allergens: ["fish"], dietary: ["gf"] },
      { name: "House-cured salmon", photo: "cured-salmon", description: "Beetroot and gin cure, crème fraîche, dill", price: 1200, allergens: ["fish","milk"], dietary: ["gf"] },
    ],
  },
  {
    category: "Small plates",
    blurb: "Made to share, or not.",
    items: [
      { name: "Saffron arancini", photo: "arancini", description: "Mozzarella heart, saffron aioli", price: 850, allergens: ["gluten","milk","egg"], dietary: ["v"] },
      { name: "Grilled prawns", photo: "prawns", description: "Garlic, chilli, parsley, lemon", price: 1350, allergens: ["crustaceans"], dietary: ["gf","spicy"] },
      { name: "Padrón peppers", photo: "padron", description: "Blistered, sea salt, romesco", price: 650, allergens: ["nuts"], dietary: ["vg","gf"] },
      { name: "Chicken liver pâté", photo: "pate", description: "Madeira jelly, pickles, toasted brioche", price: 900, allergens: ["milk","gluten","egg","sulphites"] },
      { name: "Fritto misto", photo: "fritto", description: "Squid, prawns and courgette, lemon mayonnaise", price: 1150, allergens: ["molluscs","crustaceans","gluten","egg"] },
      { name: "Ham hock croquettes", photo: "croquettes", description: "Parsley, mustard mayonnaise", price: 800, allergens: ["gluten","milk","egg","mustard"] },
      {
        name: "Crispy squid", photo: "squid",
        description: "Lemon aioli, pickled cucumber",
        price: 900,
        allergens: ["molluscs", "egg", "gluten"],
      },
      {
        name: "Clams, nduja and white wine",
        description: "Parsley, garlic, grilled sourdough for the broth",
        price: 1250,
        allergens: ["molluscs", "gluten", "sulphites"],
        dietary: ["spicy"],
        photo: "clams",
      },
      {
        name: "Seared scallops",
        description: "Peas, lime, brown butter crumb",
        price: 1450,
        allergens: ["molluscs", "milk", "gluten"],
        photo: "scallops",
        featured: true,
        stock: 12,
      },
      {
        name: "Charred broccoli", photo: "broccoli",
        description: "Tahini, chilli, toasted almonds",
        price: 750,
        allergens: ["sesame", "nuts"],
        dietary: ["vg", "gf"],
      },
      {
        name: "Garden leaves",
        description: "Buttermilk dressing, pickled shallot, seeds",
        price: 800,
        allergens: ["milk"],
        dietary: ["v", "gf"],
        photo: "greens",
      },
    ],
  },
  {
    category: "Fresh pasta",
    blurb: "Rolled by hand every afternoon.",
    items: [
      { name: "Cacio e pepe", photo: "cacio", description: "Tonnarelli, pecorino, a lot of black pepper", price: 1350, allergens: ["gluten","egg","milk"], dietary: ["v"] },
      { name: "Prawn linguine", photo: "linguine", description: "Tomato, chilli, garlic, lemon zest", price: 1800, allergens: ["gluten","egg","crustaceans"], dietary: ["spicy"] },
      { name: "Potato gnocchi", photo: "gnocchi", description: "Gorgonzola, walnuts, sage", price: 1500, allergens: ["gluten","milk","nuts"], dietary: ["v"] },
      { name: "Lasagne al forno", photo: "lasagne", description: "Beef and pork ragù, béchamel, eight layers", price: 1700, allergens: ["gluten","egg","milk","celery"] },
      { name: "Wild mushroom tagliatelle", photo: "mushroom-tagliatelle", description: "Porcini, mascarpone, thyme", price: 1600, allergens: ["gluten","egg","milk"], dietary: ["v"] },
      {
        name: "Tagliatelle carbonara",
        description: "Guanciale, pecorino, black pepper, confit yolk",
        price: 1500,
        allergens: ["gluten", "egg", "milk"],
        photo: "tagliatelle",
        featured: true,
      },
      {
        name: "Pappardelle and beef shin ragù",
        description: "Red wine, rosemary, gremolata",
        price: 1750,
        allergens: ["gluten", "egg", "celery", "sulphites"],
        photo: "pappardelle",
      },
      {
        name: "Green pea and broad bean risotto",
        description: "Mint, lemon, aged parmesan",
        price: 1600,
        allergens: ["milk", "celery"],
        dietary: ["v", "gf"],
        photo: "risotto",
        groups: [{ name: "Make it vegan", min: 0, max: 1, options: [["Vegan, no parmesan", 0]] }],
      },
      {
        name: "Spinach and ricotta ravioli", photo: "ravioli",
        description: "Brown butter, sage, toasted walnuts",
        price: 1550,
        allergens: ["gluten", "egg", "milk", "nuts"],
        dietary: ["v"],
      },
    ],
  },
  {
    category: "From the wood fire",
    blurb: "Oak and charcoal, lit at noon.",
    items: [
      { name: "Ribeye on the bone, for two", photo: "ribeye", description: "900 g, 45-day aged, bone marrow butter", price: 6500, dietary: ["gf"], stock: 6 },
      { name: "Pork chop", photo: "pork-chop", description: "Middle White, apple ketchup, crackling", price: 2200, dietary: ["gf"] },
      { name: "Lamb cutlets", photo: "lamb-cutlets", description: "Anchovy, rosemary, salsa verde", price: 2600, allergens: ["fish"], dietary: ["gf"] },
      { name: "Whole sea bream", photo: "bream", description: "Grilled over oak, lemon, oregano", price: 2400, allergens: ["fish"], dietary: ["gf"] },
      { name: "Grilled octopus", photo: "octopus", description: "Smoked paprika, potatoes, aioli", price: 2100, allergens: ["molluscs","egg"], dietary: ["gf"] },
      { name: "Duck breast", photo: "duck", description: "Cherries, chicory, red wine", price: 2500, allergens: ["sulphites"], dietary: ["gf"] },
      {
        name: "Fennel sausage flatbread",
        description: "Fior di latte, tomato, chilli honey",
        price: 1300,
        allergens: ["gluten", "milk"],
        dietary: ["spicy"],
        photo: "flatbread",
      },
      {
        name: "Flat iron steak",
        description: "28-day aged, chimichurri, charred onion",
        price: 2600,
        dietary: ["gf"],
        photo: "steak",
        featured: true,
        groups: [{ name: "Cooked", min: 1, max: 1, options: [["Rare", 0], ["Medium rare", 0], ["Medium", 0]] }],
      },
      {
        name: "Braised short rib",
        description: "Smoked onion, bone marrow gravy, greens",
        price: 2400,
        allergens: ["celery", "sulphites"],
        photo: "short-rib",
        stock: 10,
      },
      {
        name: "Half chicken",
        description: "Lemon, thyme, garlic, roasting juices",
        price: 1900,
        dietary: ["gf"],
        photo: "chicken",
      },
      {
        name: "Market fish",
        description: "Today's catch, brown butter, capers",
        price: 2100,
        allergens: ["fish", "milk"],
        dietary: ["gf"],
        photo: "fish",
        featured: true,
        stock: 10,
      },
      {
        name: "Slow roast lamb shoulder", photo: "lamb",
        description: "For two to share. Salsa verde, crushed potatoes",
        price: 2400,
        allergens: ["sulphites"],
        dietary: ["gf"],
        stock: 8,
      },
      {
        name: "Fire-grilled burger", photo: "burger",
        description: "Aged beef, smoked cheddar, house pickles, brioche",
        price: 1550,
        allergens: ["gluten", "milk", "egg", "mustard"],
        groups: [
          { name: "Cooked", min: 1, max: 1, options: [["Medium", 0], ["Well done", 0]] },
          {
            name: "Extras",
            min: 0,
            max: 3,
            options: [["Bacon", 150], ["Extra cheese", 100], ["Fried egg", 120]],
          },
        ],
      },
    ],
  },
  {
    category: "Sides",
    blurb: "For the table.",
    items: [
      { name: "Three-cheese macaroni", photo: "macaroni", description: "Baked with a crumb crust", price: 650, allergens: ["gluten","milk"], dietary: ["v"] },
      { name: "Heritage tomato salad", photo: "tomato-salad", description: "Red onion, oregano, good olive oil", price: 600, dietary: ["vg","gf"] },
      { name: "Grilled asparagus", photo: "asparagus", description: "Lemon, parmesan", price: 700, allergens: ["milk"], dietary: ["v","gf"] },
      { name: "Fries", photo: "fries", description: "Rosemary salt", price: 450, dietary: ["vg", "gf"] },
      {
        name: "Crushed potatoes", photo: "potatoes",
        description: "Salsa verde, sea salt",
        price: 500,
        dietary: ["vg", "gf"],
      },
      {
        name: "Roast Brussels sprouts", photo: "sprouts",
        description: "Miso butter, crispy shallots, lemon",
        price: 550,
        allergens: ["milk", "soya"],
        dietary: ["v"],
      },
      {
        name: "Green salad",
        description: "Mustard dressing, soft herbs",
        price: 450,
        allergens: ["mustard"],
        dietary: ["vg", "gf"],
        photo: "salad",
      },
      {
        name: "Roast carrots", photo: "carrots",
        description: "Whipped feta, honey, dukkah",
        price: 550,
        allergens: ["milk", "nuts", "sesame"],
        dietary: ["v", "gf"],
      },
    ],
  },
  {
    category: "Desserts",
    blurb: "Worth leaving room for.",
    items: [
      { name: "Vanilla panna cotta", photo: "panna-cotta", description: "Poached rhubarb, ginger crumb", price: 750, allergens: ["milk","gluten"], dietary: ["v"] },
      { name: "Crème brûlée", photo: "brulee", description: "Tonka bean, shortbread", price: 750, allergens: ["milk","egg","gluten"], dietary: ["v"] },
      { name: "Lemon meringue tart", photo: "lemon-tart", description: "Burnt Italian meringue", price: 800, allergens: ["gluten","milk","egg"], dietary: ["v"] },
      { name: "Sticky toffee pudding", photo: "toffee-pudding", description: "Butterscotch, clotted cream", price: 800, allergens: ["gluten","milk","egg"], dietary: ["v"] },
      { name: "Three British cheeses", photo: "cheeses", description: "Chutney, oatcakes, grapes", price: 1250, allergens: ["milk","gluten","sulphites"], dietary: ["v"] },
      {
        name: "Dark chocolate tart",
        description: "Crème fraîche, sea salt",
        price: 800,
        allergens: ["gluten", "milk", "egg"],
        dietary: ["v"],
        photo: "tart",
        featured: true,
        stock: 6,
      },
      {
        name: "Tiramisu",
        description: "Mascarpone, espresso, Marsala",
        price: 850,
        allergens: ["gluten", "milk", "egg", "sulphites"],
        dietary: ["v"],
        photo: "tiramisu",
      },
      {
        name: "Burnt caramel cheesecake",
        description: "Salted caramel, shortbread",
        price: 800,
        allergens: ["gluten", "milk", "egg"],
        dietary: ["v"],
        photo: "caramel",
      },
      { name: "Affogato", photo: "affogato", description: "Vanilla gelato, espresso", price: 650, allergens: ["milk"], dietary: ["v", "gf"] },
      { name: "Raspberry sorbet", photo: "sorbet", description: "Two scoops, candied orange", price: 600, dietary: ["vg", "gf"] },
    ],
  },
  {
    category: "Cocktails",
    blurb: "Stirred and shaken at the bar.",
    items: [
      { name: "Mezcal margarita", photo: "margarita", description: "Mezcal, lime, agave, chilli salt", price: 1200 },
      { name: "Aperol spritz", photo: "aperol", description: "Aperol, prosecco, soda, orange", price: 950, allergens: ["sulphites"] },
      { name: "Dry martini", photo: "martini", description: "Gin or vodka, stirred, olive or twist", price: 1150 },
      { name: "Whisky sour", photo: "whisky-sour", description: "Scotch, lemon, bitters, egg white", price: 1100, allergens: ["egg"] },
      {
        name: "Rhubarb spritz",
        description: "Rhubarb cordial, prosecco, soda",
        price: 1000,
        allergens: ["sulphites"],
        photo: "cocktail",
      },
      { name: "Smoked old fashioned", photo: "old-fashioned", description: "Bourbon, demerara, oak smoke", price: 1200 },
      { name: "Espresso martini", photo: "espresso-martini", description: "Vodka, coffee liqueur, fresh espresso", price: 1100 },
      { name: "Garden negroni", photo: "negroni", description: "Gin, bitter aperitivo, vermouth, basil", price: 1150, allergens: ["sulphites"] },
      { name: "Elderflower tonic", photo: "tonic", description: "Alcohol free. Elderflower, cucumber, tonic", price: 650 },
    ],
  },
  {
    category: "Wine and beer",
    blurb: "A short list that changes with the season.",
    items: [
      { name: "Provence rosé", photo: "rose", description: "Côtes de Provence, France", price: 850, allergens: ["sulphites"] },
      { name: "English sparkling", photo: "english-sparkling", description: "Classic cuvée, Sussex", price: 1300, allergens: ["sulphites"] },
      { name: "Lager", photo: "lager", description: "Bristol-brewed, pint", price: 650, allergens: ["gluten"] },
      {
        name: "House red", photo: "red-wine",
        description: "Montepulciano d'Abruzzo, Italy",
        price: 750,
        allergens: ["sulphites"],
        groups: [{ name: "Size", min: 1, max: 1, options: [["175 ml glass", 0], ["250 ml glass", 250], ["Bottle", 2150]] }],
      },
      {
        name: "House white", photo: "white-wine",
        description: "Picpoul de Pinet, France",
        price: 750,
        allergens: ["sulphites"],
        groups: [{ name: "Size", min: 1, max: 1, options: [["175 ml glass", 0], ["250 ml glass", 250], ["Bottle", 2150]] }],
      },
      { name: "Prosecco", photo: "prosecco", description: "Glass", price: 850, allergens: ["sulphites"] },
      { name: "Pale ale", photo: "ale", description: "Local brewery, 330 ml", price: 600, allergens: ["gluten"] },
    ],
  },
  {
    category: "Soft drinks and coffee",
    blurb: "Pressed, brewed and poured here.",
    items: [
      { name: "Cold brew", photo: "cold-brew", description: "Steeped overnight, over ice", price: 400, allergens: ["milk"] },
      { name: "Hot chocolate", photo: "hot-chocolate", description: "70% dark, steamed milk", price: 420, allergens: ["milk"] },
      { name: "Fresh orange juice", photo: "orange-juice", description: "Squeezed to order", price: 450 },
      { name: "Sparkling water", photo: "water", price: 300 },
      { name: "Fresh lemonade", photo: "lemonade", description: "Lemon, mint, a little sugar", price: 400 },
      {
        name: "Flat white", photo: "flat-white",
        price: 350,
        allergens: ["milk"],
        groups: [{ name: "Milk", min: 1, max: 1, options: [["Whole", 0], ["Oat", 40]] }],
      },
      { name: "Espresso", photo: "espresso", price: 280 },
      { name: "Fresh mint tea", photo: "mint-tea", price: 320 },
    ],
  },
  {
    category: "Little ones",
    blurb: "For under twelves, with a drink and a scoop to follow.",
    items: [
      { name: "Tomato spaghetti", photo: "kids-pasta", description: "Fresh pasta, tomato sauce, parmesan on the side", price: 700, allergens: ["gluten","egg","milk"], dietary: ["v"] },
      { name: "Chicken and chips", photo: "kids-chicken", description: "Breaded chicken, fries, ketchup", price: 750, allergens: ["gluten","egg"] },
      { name: "Two scoops", photo: "kids-ice-cream", description: "Vanilla, chocolate or strawberry", price: 400, allergens: ["milk"], dietary: ["v","gf"] },
    ],
  },
];

export interface SeedOptions {
  kitchenCode?: string;
  openingHours?: OpeningHours;
  slug?: string;
}

export interface SeedResult {
  tenantId: string;
  locationId: string;
  locationSlug: string;
  tables: { id: string; label: string; token: string }[];
  users: Record<keyof typeof DEMO_ACCOUNTS, string>;
}

/** Wipes all data and creates one demo restaurant. */
export async function seedDemo(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  await db.execute(sql`
    truncate table outbox, payments, rewards, sessions, waitlist, reservations, order_transitions,
      order_items, orders, users, modifiers, modifier_groups, menu_items, menu_categories, dining_tables,
      locations, tenants restart identity cascade
  `);
  const hashes = await hashDemoPasswords();

  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({ slug: "passplate", name: "PassPlate" })
      .returning();
    const [location] = await tx
      .insert(locations)
      .values({
        tenantId: tenant!.id,
        slug: opts.slug ?? "passplate",
        name: "PassPlate",
        openingHours: opts.openingHours ?? ALWAYS_OPEN,
        bookingHours: BOOKING_HOURS,
        lat: 51.4497,
        lng: -2.5966,
        targetPrepSeconds: 15 * 60,
        kitchenTokenHash: hashToken(opts.kitchenCode ?? DEMO_KITCHEN_CODE),
      })
      .returning();
    const locationId = location!.id;

    const tables = await tx
      .insert(diningTables)
      .values(
        FLOOR.map((t) => ({
          locationId,
          ...t,
          qrToken: randomBytes(9).toString("base64url"),
        })),
      )
      .returning();

    const accountRows = await tx
      .insert(users)
      .values(
        (Object.keys(DEMO_ACCOUNTS) as (keyof typeof DEMO_ACCOUNTS)[]).map((role) => ({
          email: DEMO_ACCOUNTS[role].email,
          name: DEMO_ACCOUNTS[role].name,
          passwordHash: hashes[role],
          role,
          phone: role === "customer" ? "07700 900123" : null,
          locationId: role === "customer" ? null : locationId,
        })),
      )
      .returning({ id: users.id, role: users.role });
    const userIds = Object.fromEntries(accountRows.map((u) => [u.role, u.id])) as Record<
      keyof typeof DEMO_ACCOUNTS,
      string
    >;

    for (const [cIndex, section] of MENU.entries()) {
      const [category] = await tx
        .insert(menuCategories)
        .values({ locationId, name: section.category, blurb: section.blurb, position: cIndex })
        .returning();
      for (const [iIndex, item] of section.items.entries()) {
        const [row] = await tx
          .insert(menuItems)
          .values({
            locationId,
            categoryId: category!.id,
            name: item.name,
            description: item.description ?? null,
            priceMinor: item.price,
            allergens: item.allergens ?? [],
            dietary: item.dietary ?? [],
            image: item.photo ? `/media/dish-${item.photo}.jpg` : null,
            featured: item.featured ?? false,
            stock: item.stock ?? null,
            position: iIndex,
          })
          .returning();
        for (const [gIndex, group] of (item.groups ?? []).entries()) {
          const [g] = await tx
            .insert(modifierGroups)
            .values({
              itemId: row!.id,
              name: group.name,
              minSelect: group.min,
              maxSelect: group.max,
              position: gIndex,
            })
            .returning();
          await tx.insert(modifiers).values(
            group.options.map(([name, delta], oIndex) => ({
              groupId: g!.id,
              name,
              priceDeltaMinor: delta,
              position: oIndex,
            })),
          );
        }
      }
    }

    return {
      tenantId: tenant!.id,
      locationId,
      locationSlug: location!.slug,
      tables: tables.map((t) => ({ id: t.id, label: t.label, token: t.qrToken })),
      users: userIds,
    };
  });
}
