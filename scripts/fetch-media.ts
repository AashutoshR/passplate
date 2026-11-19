/**
 * Downloads the site's footage and dish photography into apps/web/public/media.
 *
 * Everything comes from Pexels (Pexels license) and was shot between 2019 and
 * 2024 by the photographers named below: real kitchens, real food, no AI.
 * The raw files stay out of git: the license does not allow redistributing
 * them as a collection.
 *
 * Usage: bun run media
 */
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../apps/web/public/media/", import.meta.url));
const v = (id: number, file: string) => `https://videos.pexels.com/video-files/${id}/${id}-${file}.mp4`;
const p = (id: number) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1400`;

/** Hero films in the order they play: the room, the fire, the pan, the plate. */
const FILMS: { id: number; by: string; hd: string; sm: string }[] = [
  { id: 3768985, by: "Taryn Elliott", hd: "hd_1280_720_25fps", sm: "sd_640_360_25fps" },
  { id: 2894888, by: "Kelly", hd: "hd_1280_720_24fps", sm: "sd_640_360_24fps" },
  { id: 3768982, by: "Taryn Elliott", hd: "hd_1280_720_25fps", sm: "sd_640_360_25fps" },
  { id: 8626677, by: "Kampus Production", hd: "hd_1280_720_25fps", sm: "sd_640_360_25fps" },
  { id: 4253135, by: "cottonbro studio", hd: "hd_1366_720_50fps", sm: "sd_640_338_25fps" },
  { id: 4252810, by: "cottonbro studio", hd: "hd_1366_720_50fps", sm: "sd_640_338_25fps" },
  { id: 3209799, by: "Pressmaster", hd: "hd_1280_720_25fps", sm: "sd_640_360_25fps" },
  { id: 4099111, by: "Taryn Elliott", hd: "hd_1280_720_24fps", sm: "sd_640_360_24fps" },
  { id: 7818021, by: "Mario Schafer", hd: "hd_1280_720_24fps", sm: "sd_640_360_24fps" },
  { id: 8477270, by: "Cristian Rojas", hd: "hd_1280_720_24fps", sm: "sd_640_360_24fps" },
  { id: 4926209, by: "Roman Odintsov", hd: "hd_1366_720_30fps", sm: "sd_640_338_30fps" },
  { id: 10432183, by: "RDNE Stock project", hd: "hd_1280_720_30fps", sm: "sd_640_360_30fps" },
  { id: 4253325, by: "cottonbro studio", hd: "hd_1366_720_50fps", sm: "sd_640_338_25fps" },
  { id: 3209765, by: "Pressmaster", hd: "hd_1280_720_25fps", sm: "sd_640_360_25fps" },
];

/** Dish photographs, keyed by the name the menu seed uses. */
export const PHOTOS: Record<string, number> = {
  bread: 4109508,
  oysters: 18255861,
  burrata: 20184727,
  clams: 4871121,
  scallops: 16922434,
  tagliatelle: 546945,
  pappardelle: 6213734,
  steak: 6213710,
  "short-rib": 16444386,
  chicken: 6163330,
  fish: 17010950,
  risotto: 6544216,
  flatbread: 20862567,
  tart: 6378950,
  tiramisu: 19992962,
  cocktail: 4485364,
  caramel: 10169991,
  beetroot: 8696556,
  salad: 4198017,
  greens: 11287049,
  olives: 5589038,
  squid: 15801007,
  broccoli: 4577162,
  ravioli: 13669035,
  lamb: 20226299,
  burger: 5374420,
  fries: 8272619,
  potatoes: 8299597,
  sprouts: 3510155,
  carrots: 8477221,
  affogato: 12914800,
  sorbet: 13068808,
  "old-fashioned": 16444385,
  "espresso-martini": 15389024,
  negroni: 1304540,
  tonic: 16550820,
  "red-wine": 9007297,
  "white-wine": 10403547,
  prosecco: 20303995,
  ale: 8864540,
  water: 13723906,
  lemonade: 4134388,
  "flat-white": 14689202,
  espresso: 11160148,
  "mint-tea": 17138078,
  margherita: 18437684,
  "nduja-pizza": 3682837,
  "mushroom-pizza": 17402716,
  "four-cheese": 10406184,
  "garlic-flatbread": 10337726,
  tartare: 18437702,
  crudo: 17942045,
  "cured-salmon": 19302567,
  arancini: 5056867,
  prawns: 16482466,
  padron: 18103897,
  pate: 8696528,
  fritto: 16533150,
  croquettes: 18001753,
  cacio: 5336537,
  linguine: 19671377,
  gnocchi: 9249364,
  lasagne: 16845653,
  "mushroom-tagliatelle": 5531093,
  ribeye: 16272317,
  "pork-chop": 7333258,
  "lamb-cutlets": 18330965,
  bream: 6213713,
  octopus: 10134725,
  duck: 17751633,
  macaroni: 10993148,
  "tomato-salad": 15265259,
  asparagus: 4051007,
  "panna-cotta": 3301907,
  brulee: 5677282,
  "lemon-tart": 7451880,
  "toffee-pudding": 5419205,
  cheeses: 543733,
  margarita: 6428258,
  aperol: 10085714,
  martini: 4051395,
  "whisky-sour": 18022230,
  rose: 4946408,
  "english-sparkling": 10699058,
  lager: 8508488,
  "cold-brew": 4869290,
  "hot-chocolate": 10002425,
  "orange-juice": 6412584,
  "kids-pasta": 11654230,
  "kids-chicken": 14537698,
  "kids-ice-cream": 8104733,
};

const files: { name: string; url: string }[] = [
  ...FILMS.flatMap((f, i) => {
    const n = String(i + 1).padStart(2, "0");
    return [
      { name: `film-${n}.mp4`, url: v(f.id, f.hd) },
      { name: `film-${n}-sm.mp4`, url: v(f.id, f.sm) },
    ];
  }),
  // The tall kitchen portrait used on the story page.
  { name: "kitchen-960.mp4", url: v(4253333, "sd_506_960_25fps") },
  { name: "kitchen-640.mp4", url: v(4253333, "sd_338_640_25fps") },
  ...Object.entries(PHOTOS).map(([key, id]) => ({ name: `dish-${key}.jpg`, url: p(id) })),
];

if (import.meta.main) {
  mkdirSync(dir, { recursive: true });
  const todo = files.filter((f) => !existsSync(dir + f.name));
  console.log(`${files.length - todo.length} already there, fetching ${todo.length}`);
  // A few at a time: fast, and polite to the CDN.
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(
      todo.slice(i, i + 6).map(async (f) => {
        const res = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (passplate media script)" } });
        if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status} from ${f.url}`);
        await Bun.write(dir + f.name, res);
        console.log(`${f.name}: ${(Bun.file(dir + f.name).size / 1024 / 1024).toFixed(1)} MB`);
      }),
    );
  }
}
