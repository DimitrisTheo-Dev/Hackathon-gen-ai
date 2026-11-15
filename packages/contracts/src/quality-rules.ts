import type { Composition } from "./composition.js";
import type { ClaimKind, ContentReview, Product, RegulatedDomain, ReviewClaim, ReviewFinding, ReviewSeverity, ReviewStatus } from "./quality.js";

/**
 * Deterministic review rules, shared by the engine (basic mode, and the delivery and visual passes in every mode) and the
 * studio's local fixture, so both say the same thing about the same script. English and Greek. Health comes first.
 *
 * These rules find wording that needs a source or an expert; they never decide that a claim is true. Only an approved
 * product fact counts as support here; the engine's `ai` mode may add cited sources.
 */

/* ───────────────────────── text helpers ───────────────────────── */

/** Lowercase, accents removed (Greek tonos too), final sigma folded, whitespace collapsed. */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/ς/g, "σ").replace(/\s+/g, " ").trim();
}

const WORD = /[\p{L}\p{N}]+(?:[.,]\d+)?%?/gu;
const tokens = (text: string) => normalizeText(text).match(WORD) ?? [];
const isNumber = (token: string) => /^\d/.test(token);
/** Standalone numbers only: the 3 in "omega-3" or the 19 in "COVID-19" names something, it is not a quantity. */
const numbersOf = (text: string) => (normalizeText(text).match(/(?<![\p{L}\p{N}][-‐]?)\d+(?:[.,]\d+)?/gu) ?? []).map((n) => n.replace(",", "."));

/** Words written with `*` for "any ending" and spaces for any whitespace, matched on normalized text. */
function lexicon(words: string[]): RegExp {
  const body = words
    .map((word) => normalizeText(word).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*|\*/g, "[\\p{L}\\p{N}]*").replace(/ /g, "\\s+"))
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "u");
}

const STOP = new Set(
  "a an and are as at be but by for from has have in is it its of on or our that the their this to was we were will with you your can may more most very just also into than then them these those so not no do does did here there what which who how all any each every about over such only own same too both after before during per via και ειναι στο στη στην στον στα στους με για απο που να θα το τα του της των τη την τον οι η ο ενα μια μας σας τους πολυ πιο οπωσ οτι αλλα ή ως σε".split(" "),
);
/** Content words, crudely stemmed to a 5-letter prefix so "reduces" meets "reduce" and "θεραπεία" meets "θεραπευτικό". */
const contentWords = (text: string) => new Set(tokens(text).filter((t) => isNumber(t) || (t.length > 2 && !STOP.has(t))).map((t) => (isNumber(t) ? t : t.slice(0, 5))));

/** Sentences with their exact text. Splits on . ! ? ; (Greek question mark) · and line breaks, not on "Dr." or "2.5". */
export function splitSentences(script: string): string[] {
  const out: string[] = [];
  let start = 0;
  const abbreviation = /(?:^|\s)(?:dr|mr|mrs|ms|prof|st|vs|etc|e\.g|i\.e|κ|δρ)\.$/i;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1] ?? "";
    const end = ch === "\n" || ((ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === "·" || ch === "…") && (next === "" || /\s/.test(next)));
    if (!end) continue;
    if (ch === "." && abbreviation.test(script.slice(Math.max(0, i - 5), i + 1))) continue;
    const sentence = script.slice(start, i + 1).trim();
    if (sentence.replace(/[\s.!?;·…]/g, "")) out.push(sentence);
    start = i + 1;
  }
  const tail = script.slice(start).trim();
  if (tail.replace(/[\s.!?;·…]/g, "")) out.push(tail);
  return out;
}

/* ───────────────────────── lexicons ───────────────────────── */

const HEALTH_TOPIC = lexicon([
  "cure*", "heal*", "treat*", "prevent*", "diagnos*", "disease*", "symptom*", "therap*", "medicine*", "medical", "medication*", "prescri*",
  "dosage", "dose", "doses", "clinical*", "doctor*", "physician*", "dr", "nurse*", "patient*", "blood pressure", "cholesterol", "diabet*", "cancer*",
  "anxiety", "depression", "immun*", "infection*", "supplement*", "vitamin*", "detox*", "weight loss", "lose weight", "side effect*", "pharmac*",
  "hospital*", "allerg*", "inflammation", "chronic", "θεραπ*", "γιατρ*", "ιατρ*", "ασθεν*", "φαρμακ*", "συμπτωμ*", "πιεση", "χοληστεριν*",
  "διαβητ*", "καρκιν*", "ανοσοποιητικ*", "συμπληρωμα*", "βιταμιν*", "αδυνατισμ*", "παρενεργει*", "νοσο*", "νοσημα*", "κλινικ*", "δοσολογ*",
  "δοση", "αλλεργ*", "φλεγμον*", "λοιμωξ*",
]);
const HEALTH_WEAK = lexicon(["health", "healthy", "wellness", "wellbeing", "well-being", "sleep", "stress", "υγει*", "ευεξι*", "υπνο*", "αγχο*"]);
const FINANCE_TOPIC = lexicon([
  "invest*", "returns", "roi", "profit*", "interest rate*", "apr", "apy", "loan*", "mortgage*", "crypto*", "bitcoin", "stock*", "trading", "trader*",
  "retire*", "pension*", "financial advice", "επενδ*", "αποδοσ*", "δανει*", "επιτοκι*", "κρυπτο*", "μετοχ*", "συνταξ*", "αποταμιευσ*", "χρηματιστηρι*",
]);

/** Promises regulators and platforms reject on sight. */
const HEALTH_RISKY = lexicon([
  "cure*", "heals", "heal", "healing", "no side effect*", "without side effect*", "100% safe", "completely safe", "safe for everyone", "miracle*",
  "instant relief", "detox*", "guaranteed results", "θεραπευει", "θεραπευουν", "εξαφανιζ*", "χωρισ παρενεργει*", "απολυτα ασφαλ*", "θαυματουργ*",
  "αποτοξιν*",
]);
/** Endorsement and proof claims: they need evidence, and a doctor's endorsement needs a named professional who agreed to it. */
const HEALTH_ENDORSEMENT = lexicon([
  "clinically proven", "scientifically proven", "clinically tested", "doctor recommended", "doctor-recommended", "doctors recommend*",
  "recommended by doctors", "dermatologist recommended", "κλινικα αποδεδειγμεν*", "επιστημονικα αποδεδειγμεν*", "κλινικα ελεγμεν*",
  "συνιστουν οι γιατροι", "προτεινεται απο γιατρουσ", "προτεινουν οι γιατροι",
]);
const HEALTH_RISKY_PATTERN = /(?<![\p{L}\p{N}])(lose|χασετε|χανετε)\s+\d+\s*(kg|kilos?|pounds|lbs|κιλα)(?![\p{L}\p{N}])/u;
/** Health benefits that may be true but need a qualified person. */
const HEALTH_CLAIM = lexicon([
  "treat*", "prevent*", "reduce* the risk", "reduce* risk", "reduce* symptom*", "reduce* pain", "reduce* inflammation", "lower* blood pressure",
  "lower* cholesterol", "lower* blood sugar", "reduce* blood pressure", "reduce* cholesterol", "boost* your immun*", "boost* immun*",
  "strengthen* your immun*", "strengthen* immun*", "improve* your sleep", "improve* sleep", "improve* digestion", "improve* memory",
  "support* your immun*", "support* immun*", "support* heart health", "support* joint*", "relie* pain", "relie* stress", "relie* anxiety",
  "relie* symptom*", "help* with pain", "help* you sleep", "help* you lose weight", "burn* fat", "fat burning",
  "προλαμβαν*", "προληψη", "μειων* τον κινδυνο", "μειων* τα συμπτωματα", "μειων* τον πονο", "μειων* την πιεση", "μειων* τη χοληστεριν*",
  "μειων* το σακχαρο", "μειων* το αγχοσ", "ενισχυ* το ανοσοποιητικ*", "ενισχυ* ανοσοποιητικ*", "βελτιων* τον υπνο", "βελτιων* την πεψη",
  "βελτιων* τη μνημη", "ανακουφιζ*", "θεραπεια", "καιει λιποσ",
]);
const FINANCE_RISKY = lexicon([
  "guarantee* return*", "guarantee* profit*", "guarantee* income", "guaranteed", "risk-free", "risk free", "no risk", "double your money",
  "double your investment", "get rich", "can't lose", "cannot lose", "passive income", "εγγυημεν* αποδοσ*", "εγγυημεν* κερδ*", "χωρισ ρισκο",
  "χωρισ κινδυνο", "διπλασιασ*",
]);
const FINANCE_CLAIM = /(\d+([.,]\d+)?\s*%\s*(return|interest|apy|apr|yield|profit|a year|per year|annually|αποδοσ|τοκο|ετησιωσ))|((earn|make|κερδισ\p{L}*)\s+(€|\$|£)?\s*\d+)/u;
const LEGAL = lexicon([
  "approved by", "certified", "fda", "ema", "eof", "εοφ", "licensed", "patented", "award-winning", "award winning", "πιστοποιημεν*", "εγκεκριμεν*",
  "βραβευμεν*",
]);
const NUMBER_CLAIM =
  /\d+([.,]\d+)?\s*(%|percent|τοισ εκατο|x(?![\p{L}])|times|φορεσ|days?|weeks?|months?|years?|hours?|minutes?|ημερ\p{L}*|εβδομαδ\p{L}*|μην\p{L}*|χρον\p{L}*|ωρ\p{L}*|λεπτ\p{L}*|kg|kilos?|κιλα|mg|g(?![\p{L}])|calories|kcal|θερμιδ\p{L}*)|\d+\s+(out of|in|στουσ|στα)\s+\d+/u;
const COMPARATIVE = lexicon([
  "best", "#1", "number one", "no. 1", "no 1", "the only", "only one", "first ever", "fastest", "strongest", "most effective", "more effective",
  "better than", "unbeatable", "always works", "never fails", "100%", "καλυτερ*", "νουμερο ενα", "το μοναδικο", "ο μοναδικοσ", "η μοναδικη",
  "πιο αποτελεσματικ*", "ασυναγωνιστ*",
]);
const PRICE = /([€$£]\s?\d)|(\d+([.,]\d+)?\s?(€|eur|euros?|ευρω|dollars?|usd)(?![\p{L}]))|(?<![\p{L}])(free|δωρεαν|discount|εκπτωσ\p{L}*|half price|μισοτιμ\p{L}*)(?![\p{L}])|(\d+\s?%\s?off)/u;
/** Advice to see a professional, or a disclaimer: not a claim. */
const ADVISORY = lexicon([
  "talk to your doctor", "ask your doctor", "consult your doctor", "see your doctor", "consult a doctor", "talk to a doctor", "ask your pharmacist",
  "not medical advice", "not financial advice", "for information only", "for informational purposes", "capital at risk", "συμβουλευτειτε τον γιατρο σασ",
  "συμβουλευτειτε τον γιατρο", "ρωτηστε τον γιατρο σασ", "ρωτηστε τον γιατρο", "δεν αποτελει ιατρικη συμβουλη", "δεν αποτελει επενδυτικη συμβουλη",
  "μονο για ενημερωση",
]);
const NEGATIVE_RULE = lexicon(["never", "no", "don't", "do not", "avoid", "without", "not", "μην", "ποτε", "οχι", "χωρισ", "αποφυγ*"]);
const RULE_TOPICS: Partial<Record<ClaimKind, RegExp>> = {
  health: lexicon(["medical", "health*", "cure*", "treat*", "doctor*", "ιατρ*", "υγει*", "θεραπ*", "γιατρ*"]),
  finance: lexicon(["financial", "returns", "invest*", "profit*", "επενδ*", "αποδοσ*", "κερδ*"]),
  comparative: lexicon(["compar*", "competitor*", "best", "superlative*", "συγκρι*", "ανταγωνιστ*", "καλυτερ*"]),
  price: lexicon(["price*", "pricing", "discount*", "offer*", "τιμ*", "εκπτωσ*", "προσφορ*"]),
};

/* ───────────────────────── domain ───────────────────────── */

/** Products the script names, earliest mention first, with the character index of that mention in `normalizeText(script)`. */
export function productMentions(script: string, products: ReadonlyArray<Pick<Product, "id" | "name">>): Array<{ productId: string; index: number }> {
  const text = normalizeText(script);
  const found: Array<{ productId: string; index: number }> = [];
  for (const product of products) {
    const name = normalizeText(product.name);
    if (name.length < 2) continue;
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "u").exec(text);
    if (match) found.push({ productId: product.id, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * The regulated domain of a script. A named health or finance product decides it; otherwise one strong health term,
 * two weak ones, or one strong finance term. Health wins over finance: it is the stricter review.
 */
export function detectDomain(script: string, products: ReadonlyArray<Pick<Product, "id" | "name" | "domain">> = []): RegulatedDomain {
  const named = new Set(productMentions(script, products).map((m) => m.productId));
  const domains = products.filter((p) => named.has(p.id)).map((p) => p.domain);
  if (domains.includes("health")) return "health";
  const text = normalizeText(script);
  const strong = HEALTH_TOPIC.test(text);
  const weak = (text.match(new RegExp(HEALTH_WEAK.source, "gu")) ?? []).length;
  if (strong || weak >= 2) return "health";
  if (domains.includes("finance") || FINANCE_TOPIC.test(text)) return "finance";
  return "general";
}

export const isRegulated = (domain: RegulatedDomain) => domain === "health" || domain === "finance";

/* ───────────────────────── claims (basic mode) ───────────────────────── */

type Fact = { productId: string; quote: string };

function bestFact(sentence: string, facts: Fact[]): { fact: Fact; coverage: number; shared: number } | null {
  const words = contentWords(sentence);
  let best: { fact: Fact; coverage: number; shared: number } | null = null;
  for (const fact of facts) {
    const factWords = contentWords(fact.quote);
    if (!factWords.size) continue;
    let shared = 0;
    for (const word of factWords) if (words.has(word)) shared++;
    const coverage = shared / factWords.size;
    if (!best || coverage > best.coverage) best = { fact, coverage, shared };
  }
  return best;
}

/** English-only softening of the commonest risky words; null when no safe rewrite is known. */
function soften(sentence: string): string | null {
  const rules: Array<[RegExp, string]> = [
    [/\bcures\b/gi, "may help with"],
    [/\bcure\b/gi, "help with"],
    [/\bheals\b/gi, "may support"],
    [/\b(treats)\b/gi, "may help with"],
    [/\bprevents\b/gi, "may help support"],
    [/,?\s*(with\s+)?no side effects/gi, ""],
    [/,?\s*without side effects/gi, ""],
    [/\b(clinically|scientifically) proven\s*/gi, ""],
    [/\b(doctor[- ]recommended|recommended by doctors)\s*/gi, ""],
    [/\bguaranteed\s+/gi, ""],
    [/\brisk[- ]free\b/gi, "carefully managed"],
  ];
  let next = sentence;
  for (const [pattern, replacement] of rules) next = next.replace(pattern, replacement);
  next = next.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
  return next !== sentence.trim() && next.length > 3 ? next : null;
}

const NOTES: Record<string, string> = {
  supported: "Matches an approved product fact.",
  health_risky: "A medical promise that platforms and regulators reject. Say what the product may help with, not what it cures.",
  health_endorsement: "An endorsement or proof claim needs evidence, and a doctor's endorsement needs a named professional who agreed to it.",
  finance_risky: "A guaranteed outcome. Financial promotions must not promise returns.",
  health_expert: "A health benefit that only a qualified professional can confirm.",
  finance_expert: "A financial outcome that only a qualified adviser can confirm.",
  legal: "An approval or certification claim with no approved fact behind it.",
  number: "No approved fact has this number.",
  comparative: "A comparison or superlative with nothing approved behind it.",
  price: "A price or offer. Check it is current before it goes out.",
};

/**
 * Basic-mode claims: one entry per sentence that makes a checkable claim, with the riskiest kind it shows.
 * Support comes only from approved product facts (those of products the script names, else all products).
 */
export function basicClaims(script: string, context: { products: ReadonlyArray<Pick<Product, "id" | "name" | "facts">>; brandRules: ReadonlyArray<string>; domain: RegulatedDomain }): ReviewClaim[] {
  const named = new Set(productMentions(script, context.products).map((m) => m.productId));
  const pool = context.products.filter((p) => !named.size || named.has(p.id));
  const facts: Fact[] = pool.flatMap((p) => p.facts.map((quote) => ({ productId: p.id, quote })));
  const regulated = isRegulated(context.domain);
  const claims: ReviewClaim[] = [];
  splitSentences(script).forEach((sentence, index) => {
    const text = normalizeText(sentence);
    const endorsement = HEALTH_ENDORSEMENT.test(text);
    const healthRisky = endorsement || HEALTH_RISKY.test(text) || HEALTH_RISKY_PATTERN.test(text);
    const financeRisky = FINANCE_RISKY.test(text);
    if (ADVISORY.test(text) && !healthRisky && !financeRisky) return;
    const kind: ClaimKind | null = healthRisky || HEALTH_CLAIM.test(text)
      ? "health"
      : financeRisky || FINANCE_CLAIM.test(text)
        ? "finance"
        : LEGAL.test(text)
          ? "legal"
          : NUMBER_CLAIM.test(text)
            ? "number"
            : COMPARATIVE.test(text)
              ? "comparative"
              : PRICE.test(text)
                ? "price"
                : null;
    if (!kind) return;
    const claim = (status: ReviewClaim["status"], severity: ReviewSeverity, note: string, source: ReviewClaim["source"] = null, suggestion: string | null = null): ReviewClaim => ({
      id: `c${index + 1}`,
      quote: sentence,
      kind,
      status,
      severity,
      source,
      note,
      suggestion,
    });

    // A brand guardrail that forbids this kind of claim wins over everything else.
    const topic = RULE_TOPICS[kind];
    const rule = topic ? context.brandRules.find((r) => NEGATIVE_RULE.test(normalizeText(r)) && topic.test(normalizeText(r))) : undefined;
    if (rule) {
      claims.push(claim("risky_wording", "blocking", `Your brand kit says: “${rule}”`, { type: "brand_rule", id: null, quote: rule }, healthRisky || financeRisky ? soften(sentence) : null));
      return;
    }
    if (healthRisky || financeRisky) {
      claims.push(claim("risky_wording", "blocking", endorsement ? NOTES.health_endorsement : healthRisky ? NOTES.health_risky : NOTES.finance_risky, null, soften(sentence)));
      return;
    }

    const match = bestFact(sentence, facts);
    const sentenceNumbers = numbersOf(sentence);
    if (match && match.coverage >= 0.6 && match.shared >= 2) {
      const source = { type: "product_fact" as const, id: match.fact.productId, quote: match.fact.quote };
      const factNumbers = numbersOf(match.fact.quote);
      const differs = sentenceNumbers.filter((n) => !factNumbers.includes(n));
      if (differs.length && factNumbers.length) {
        claims.push(claim("contradicted", "blocking", `The approved fact says ${factNumbers.join(", ")} where the script says ${differs.join(", ")}.`, source, match.fact.quote));
        return;
      }
      if (!differs.length) {
        claims.push(claim("supported", "info", NOTES.supported, source));
        return;
      }
    }
    if (kind === "health" || kind === "finance")
      claims.push(claim("needs_expert", regulated ? "blocking" : "warning", kind === "health" ? NOTES.health_expert : NOTES.finance_expert));
    else claims.push(claim("unsupported", regulated && (kind === "number" || kind === "legal") ? "blocking" : "warning", NOTES[kind]));
  });
  return claims;
}

/** The script with one claim's wording replaced by its suggestion, or null when the quote is no longer in the script. */
export function applySuggestion(script: string, claim: Pick<ReviewClaim, "quote" | "suggestion">): string | null {
  if (!claim.suggestion || !script.includes(claim.quote)) return null;
  return script.replace(claim.quote, claim.suggestion);
}

/* ───────────────────────── timeline helpers ───────────────────────── */

/**
 * Seconds on the timeline where character `index` of the *normalized* script is spoken (the index `productMentions`
 * returns): from word timings, else by position in the text.
 */
export function timeAtScriptIndex(script: string, composition: Pick<Composition, "durationSeconds" | "transcript">, index: number): number {
  const text = normalizeText(script);
  const before = tokens(text.slice(0, index)).length;
  const all = Math.max(1, tokens(text).length);
  const words = composition.transcript?.words ?? [];
  if (words.length) return words[Math.min(words.length - 1, Math.round((before / all) * words.length))].start;
  return Math.round(Math.min(composition.durationSeconds, (index / Math.max(1, text.length)) * composition.durationSeconds) * 10) / 10;
}

/**
 * Where a product photo starts on the timeline (place_product, its preview and the local fixture all use this): at `at`
 * when given; else where the script first names the product, moved past an opening title or statement card it would
 * sit under; else one third in. Callers clamp it to the timeline.
 */
export function productPlacementTime(
  script: string,
  composition: Pick<Composition, "durationSeconds" | "transcript" | "cards">,
  product: Pick<Product, "id" | "name">,
  at: number | null,
): { time: number; matchedMention: boolean } {
  if (at !== null) return { time: at, matchedMention: false };
  const mention = productMentions(script, [product])[0];
  if (!mention) return { time: composition.durationSeconds / 3, matchedMention: false };
  let time = timeAtScriptIndex(script, composition, mention.index);
  const opening = composition.cards.find((card) => (card.kind === "title" || card.kind === "statement") && card.start <= time && time < card.end);
  if (opening) time = opening.end;
  return { time, matchedMention: true };
}

/** Longest-common-subsequence alignment of two token lists; returns runs present only in `a` and only in `b`. */
function diffRuns(a: string[], b: string[]): { missing: Array<{ at: number; words: string[] }>; extra: Array<{ at: number; words: string[] }> } {
  const n = a.length, m = b.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const missing: Array<{ at: number; words: string[] }> = [];
  const extra: Array<{ at: number; words: string[] }> = [];
  let i = 0, j = 0;
  const push = (runs: Array<{ at: number; words: string[] }>, at: number, word: string) => {
    const last = runs.at(-1);
    if (last && last.at === at) last.words.push(word);
    else runs.push({ at, words: [word] });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) push(missing, j, a[i++]);
    else push(extra, j, b[j++]);
  }
  while (i < n) push(missing, j, a[i++]);
  while (j < m) push(extra, j, b[j++]);
  return { missing, extra };
}

const NEGATIONS = new Set(["not", "no", "never", "dont", "don't", "doesnt", "doesn't", "without", "δεν", "μην", "ποτε", "οχι", "χωρισ"]);
const isGreek = (text: string) => /[\u0370-\u03ff\u1f00-\u1fff]/.test(text);

/* ───────────────────────── delivery pass ───────────────────────── */

/**
 * Spoken words, captions and on-screen labels against the approved script. `avatarFileIds` are the project files of
 * kind `avatar_clip`; the item's own rendered presenter (`item_media`) always counts as an avatar.
 */
export function deliveryFindings(
  script: string,
  composition: Composition | null,
  context: { domain: RegulatedDomain; avatarFileIds?: ReadonlyArray<string> },
): ReviewFinding[] {
  if (!composition) return [];
  const findings: ReviewFinding[] = [];
  const regulated = isRegulated(context.domain);
  const add = (code: string, severity: ReviewSeverity, message: string, at: number | null = null) =>
    findings.push({ id: `d${findings.length + 1}`, pass: "delivery", code, severity, message, at });

  const avatars = new Set(context.avatarFileIds ?? []);
  const hasAvatar = composition.video.some((clip) => clip.layer === 0 && (clip.source.kind === "item_media" || (clip.source.kind === "file" && avatars.has(clip.source.fileId))));
  if (hasAvatar && !composition.labels.aiAvatar)
    add("ai_label_off", "blocking", "The presenter is an AI avatar, but the on-screen AI label is off. Turn it on in the timeline's labels.");
  if (regulated && !composition.labels.disclaimer.trim()) {
    const greek = isGreek(script);
    const text =
      context.domain === "health"
        ? greek ? "Μόνο για ενημέρωση, δεν αποτελεί ιατρική συμβουλή. Συμβουλευτείτε τον γιατρό σας." : "For information only, not medical advice. Talk to your doctor."
        : greek ? "Δεν αποτελεί επενδυτική συμβουλή. Το κεφάλαιο ενέχει κίνδυνο." : "Not financial advice. Capital at risk.";
    add("disclaimer_missing", "blocking", `A ${context.domain} video needs an on-screen disclaimer, for example: “${text}”`);
  }

  const words = composition.transcript?.words ?? [];
  if (!words.length) {
    add("transcript_missing", "info", "No word timings yet, so the voice was not compared with the script.");
  } else {
    const spoken = words.flatMap((w) => tokens(w.t));
    const written = tokens(script);
    const timeAt = (index: number) => words[Math.min(words.length - 1, Math.round((index / Math.max(1, spoken.length)) * words.length))]?.start ?? null;
    const spokenNumbers = new Set(spoken.filter(isNumber));
    for (const number of new Set(written.filter(isNumber)))
      if (!spokenNumbers.has(number)) add("number_mismatch", regulated ? "blocking" : "warning", `The script says “${number}”, but the voice never does.`);
    const { missing, extra } = diffRuns(written, spoken);
    for (const run of missing.filter((r) => !r.words.every(isNumber)).slice(0, 5)) {
      const flips = run.words.some((w) => NEGATIONS.has(w));
      add("words_missing", regulated || flips ? "blocking" : "warning", `The voice skips “${run.words.join(" ")}” from the script${flips ? ", which changes the meaning" : ""}.`, timeAt(run.at));
    }
    for (const run of extra.filter((r) => !r.words.every(isNumber)).slice(0, 5))
      add("words_added", regulated ? "blocking" : "warning", `The voice says “${run.words.join(" ")}”, which is not in the script.`, timeAt(run.at));
  }

  if (composition.captions.length) {
    const shown = composition.captions.flatMap((cue) => tokens(cue.text));
    const reference = words.length ? words.flatMap((w) => tokens(w.t)) : tokens(script);
    const { missing, extra } = diffRuns(reference, shown);
    const off = missing.reduce((sum, run) => sum + run.words.length, 0) + extra.reduce((sum, run) => sum + run.words.length, 0);
    if (off > Math.max(2, reference.length * 0.05)) {
      const first = extra[0] ?? missing[0];
      add("captions_differ", "warning", `The captions differ from what is said in ${off} words, starting at “${first.words.slice(0, 6).join(" ")}”.`, composition.captions[Math.min(composition.captions.length - 1, first.at)]?.start ?? null);
    }
  }
  return findings;
}

/* ───────────────────────── visual pass ───────────────────────── */

/** Where the renderer starts bottom captions (apps/web/src/video/Reel.tsx), and where TikTok and Reels draw their own UI. */
export const BOTTOM_CAPTION_TOP_PX = 1460;
export const PLATFORM_UI_TOP_PX = 1520;
/** Comfortable reading speed for on-screen text. */
export const MAX_CAPTION_WPS = 4.5;

export function visualFindings(
  script: string,
  composition: Composition | null,
  context: {
    products: ReadonlyArray<Pick<Product, "id" | "name" | "hasImage">>;
    /** Project draft files that hold each product's photo (from place_product). */
    productFileIds: Readonly<Record<string, ReadonlyArray<string>>>;
    platforms: ReadonlyArray<string>;
  },
): ReviewFinding[] {
  if (!composition) return [];
  const findings: ReviewFinding[] = [];
  const add = (code: string, severity: ReviewSeverity, message: string, at: number | null = null) =>
    findings.push({ id: `v${findings.length + 1}`, pass: "visuals", code, severity, message, at });

  const onScreen = new Set<string>();
  for (const clip of composition.video) if (clip.layer === 1 && clip.source.kind === "file") onScreen.add(clip.source.fileId);
  for (const card of composition.cards) if (card.imageFileId) onScreen.add(card.imageFileId);
  for (const mention of productMentions(script, context.products)) {
    const product = context.products.find((p) => p.id === mention.productId);
    if (!product?.hasImage) continue;
    if ((context.productFileIds[product.id] ?? []).some((id) => onScreen.has(id))) continue;
    const at = timeAtScriptIndex(script, composition, mention.index);
    add("product_not_shown", "warning", `“${product.name}” is named at ${at.toFixed(1)} s, but its photo is not on screen. Use “Show product”.`, at);
  }

  if (composition.captions.length && composition.style.captionPosition === "bottom" && context.platforms.some((p) => p === "tiktok" || p === "instagram"))
    add(
      "captions_under_platform_ui",
      "warning",
      `Bottom captions start ${1920 - BOTTOM_CAPTION_TOP_PX} px above the bottom edge, and TikTok and Reels draw their own text and buttons over about the bottom ${1920 - PLATFORM_UI_TOP_PX} px. Centre the captions for these platforms.`,
    );

  let fast = 0;
  for (const cue of composition.captions) {
    const seconds = cue.end - cue.start;
    const count = tokens(cue.text).length;
    if (seconds > 0 && count >= 3 && count / seconds > MAX_CAPTION_WPS && fast++ < 3)
      add("captions_fast", "warning", `“${cue.text}” is on screen for ${seconds.toFixed(1)} s, too short to read ${count} words.`, cue.start);
  }
  return findings;
}

/* ───────────────────────── status ───────────────────────── */

/** One rule for every caller: blocking items → needs_changes; regulated → needs a human approval; otherwise passed. */
export function reviewStatus(domain: RegulatedDomain, claims: ReadonlyArray<Pick<ReviewClaim, "severity">>, findings: ReadonlyArray<Pick<ReviewFinding, "severity">>, approved: boolean): ReviewStatus {
  if (approved) return "approved";
  if (claims.some((c) => c.severity === "blocking") || findings.some((f) => f.severity === "blocking")) return "needs_changes";
  return isRegulated(domain) ? "needs_approval" : "passed";
}

/** Blocking items an approver is accepting by approving; approving any of them needs a written reason. */
export const blockingCount = (review: Pick<ContentReview, "claims" | "findings">) =>
  review.claims.filter((c) => c.severity === "blocking").length + review.findings.filter((f) => f.severity === "blocking").length;
