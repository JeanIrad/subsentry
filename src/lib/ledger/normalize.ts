// Merchant identity: different emails name the same service differently
// ("SPOTIFY AB", "Spotify Premium", "spotify.com"). Subscriptions are keyed
// on the result, so changing this re-keys future merges — add aliases rather
// than changing the rules.

const LEGAL_SUFFIXES =
  /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|ab|sa|sarl|bv|plc|pty|oy|as|srl|kk)\b\.?/g;

// Lowercased, punctuation-free form → canonical key.
const ALIASES: Record<string, string> = {
  "hbo max": "max",
  hbomax: "max",
  "amazon prime video": "amazon prime",
  "prime video": "amazon prime",
  "amazon prime membership": "amazon prime",
  "youtube music premium": "youtube premium",
  "chatgpt plus": "chatgpt",
  openai: "chatgpt",
  "microsoft 365 family": "microsoft 365",
  "microsoft 365 personal": "microsoft 365",
  "office 365": "microsoft 365",
  "icloud+": "icloud",
  "icloud plus": "icloud",
  "disney plus": "disney+",
  "paramount plus": "paramount+",
  "apple tv plus": "apple tv+",
  "spotify premium": "spotify",
  "netflix com": "netflix",
  "new york times": "the new york times",
  nyt: "the new york times",
  "google one storage": "google one",
  "super duolingo": "duolingo",
  "canva pro": "canva",
  "grammarly pro": "grammarly",
  "linkedin premium career": "linkedin premium",
  "github copilot pro": "github copilot",
  "1password families": "1password",
  "dropbox plus": "dropbox",
};

export function merchantKey(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .replace(/\.(com|net|org|io|co|app|tv|us|uk)\b/g, "")
    .replace(/[^a-z0-9+ ]+/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ALIASES[base] ?? base;
}
