// Coarse categories for the dashboard and the priority score's overlap rule
// (SPEC §6.4). Keyed by merchantKey(); unknown merchants get "other".

export const CATEGORIES = ["video", "music", "news", "software", "cloud", "fitness", "learning", "gaming", "food", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const BY_MERCHANT: Record<string, Category> = {
  netflix: "video",
  hulu: "video",
  "disney+": "video",
  max: "video",
  "paramount+": "video",
  peacock: "video",
  "apple tv+": "video",
  "amazon prime": "video",
  "youtube premium": "video",
  "youtube tv": "video",
  crunchyroll: "video",
  spotify: "music",
  "apple music": "music",
  tidal: "music",
  deezer: "music",
  audible: "music",
  siriusxm: "music",
  pandora: "music",
  "the new york times": "news",
  "wall street journal": "news",
  "the washington post": "news",
  "the economist": "news",
  medium: "news",
  adobe: "software",
  chatgpt: "software",
  "github copilot": "software",
  "microsoft 365": "software",
  "1password": "software",
  nordvpn: "software",
  grammarly: "software",
  canva: "software",
  notion: "software",
  "linkedin premium": "software",
  "google one": "cloud",
  icloud: "cloud",
  dropbox: "cloud",
  "planet fitness": "fitness",
  peloton: "fitness",
  strava: "fitness",
  headspace: "fitness",
  calm: "fitness",
  duolingo: "learning",
  masterclass: "learning",
  coursera: "learning",
  "nintendo switch online": "gaming",
  "xbox game pass": "gaming",
  "playstation plus": "gaming",
  hellofresh: "food",
};

export function categoryFor(merchantKey: string): Category {
  return BY_MERCHANT[merchantKey] ?? "other";
}
