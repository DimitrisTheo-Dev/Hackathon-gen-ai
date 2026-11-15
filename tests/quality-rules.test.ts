import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySuggestion,
  basicClaims,
  blockingCount,
  deliveryFindings,
  detectDomain,
  draftComposition,
  productMentions,
  reviewStatus,
  splitSentences,
  timeAtScriptIndex,
  visualFindings,
  type Composition,
  type RegulatedDomain,
} from "../packages/contracts/src/index";

/**
 * The deterministic review rules in packages/contracts/src/quality-rules.ts, shared by the engine (basic mode and the
 * delivery and visual passes) and the studio's local fixture. English and Greek; health first.
 */
const VITABOOST = { id: "p1", name: "VitaBoost", domain: "health" as const, facts: ["Each capsule contains 1000 mg of vitamin C."], hasImage: true };
const claims = (script: string, options: { products?: Array<typeof VITABOOST>; rules?: string[]; domain?: RegulatedDomain } = {}) =>
  basicClaims(script, { products: options.products ?? [VITABOOST], brandRules: options.rules ?? [], domain: options.domain ?? detectDomain(script, options.products ?? [VITABOOST]) });
const summary = (list: ReturnType<typeof basicClaims>) => list.map((claim) => [claim.quote, claim.kind, claim.status, claim.severity]);

function timeline(script: string, patch: Partial<Composition> = {}, spoken?: string): Composition {
  const base = draftComposition({ title: "Test", script, brandColor: "#112233", captionPosition: "bottom", mediaDurationSeconds: null });
  const words = spoken === undefined ? null : spoken.split(/\s+/).map((t, index) => ({ t, start: index * 0.4, end: index * 0.4 + 0.35 }));
  return { ...base, transcript: words ? { language: "en", words, sourceFileId: null } : null, ...patch };
}

test("English health: a cure promise, a wrong number, an approved fact and a doctor endorsement", () => {
  const script = "VitaBoost cures colds with no side effects. Each capsule contains 2000 mg of vitamin C. Each capsule contains 1000 mg of vitamin C. Doctors recommend it.";
  assert.equal(detectDomain(script, [VITABOOST]), "health");
  const result = claims(script);
  assert.deepEqual(summary(result), [
    ["VitaBoost cures colds with no side effects.", "health", "risky_wording", "blocking"],
    ["Each capsule contains 2000 mg of vitamin C.", "number", "contradicted", "blocking"],
    ["Each capsule contains 1000 mg of vitamin C.", "number", "supported", "info"],
    ["Doctors recommend it.", "health", "risky_wording", "blocking"],
  ]);
  const [cure, contradicted, supported, endorsement] = result;
  assert.equal(cure.suggestion, "VitaBoost may help with colds.", "the cure promise and the side-effect promise are both softened");
  assert.match(contradicted.note, /approved fact says 1000 where the script says 2000/);
  assert.equal(contradicted.suggestion, VITABOOST.facts[0], "the safe rewrite restates the approved fact");
  assert.deepEqual(contradicted.source, { type: "product_fact", id: "p1", quote: VITABOOST.facts[0] });
  assert.deepEqual(supported.source, { type: "product_fact", id: "p1", quote: VITABOOST.facts[0] });
  assert.equal(supported.suggestion, null);
  assert.match(endorsement.note, /named professional/);
  assert.equal(applySuggestion(script, cure), script.replace(cure.quote, "VitaBoost may help with colds."));
  assert.equal(applySuggestion("Something else.", cure), null);
});

test("Greek health: θεραπεύει is a cure promise; ενισχύει το ανοσοποιητικό needs an expert", () => {
  const script = "Το VitaBoost θεραπεύει το κρυολόγημα. Ενισχύει το ανοσοποιητικό.";
  assert.equal(detectDomain("Ενισχύει το ανοσοποιητικό.", []), "health", "a Greek health term alone makes the script regulated");
  assert.deepEqual(summary(claims(script)), [
    ["Το VitaBoost θεραπεύει το κρυολόγημα.", "health", "risky_wording", "blocking"],
    ["Ενισχύει το ανοσοποιητικό.", "health", "needs_expert", "blocking"],
  ]);
  // The same benefit in a general script is advice to check, not a blocker.
  assert.equal(basicClaims("Ενισχύει το ανοσοποιητικό.", { products: [], brandRules: [], domain: "general" })[0].severity, "warning");
});

test("finance: guaranteed returns are rejected on sight", () => {
  const script = "Our fund offers guaranteed returns every year.";
  assert.equal(detectDomain(script, []), "finance");
  const [claim] = claims(script, { products: [] });
  assert.deepEqual([claim.kind, claim.status, claim.severity], ["finance", "risky_wording", "blocking"]);
  assert.match(claim.note, /must not promise returns/);
  assert.equal(claim.suggestion, "Our fund offers returns every year.");
  const fund = { ...VITABOOST, id: "f1", name: "Growth Fund", domain: "finance" as const, facts: [] };
  assert.equal(detectDomain("Meet the Growth Fund.", [fund]), "finance", "a named finance product decides the domain");
});

test("a brand guardrail that forbids comparisons wins over the generic rule", () => {
  const script = "We are better than any other bakery.";
  const rule = "Never compare us with competitors.";
  const [guarded] = claims(script, { products: [], rules: [rule], domain: "general" });
  assert.deepEqual([guarded.kind, guarded.status, guarded.severity], ["comparative", "risky_wording", "blocking"]);
  assert.deepEqual(guarded.source, { type: "brand_rule", id: null, quote: rule });
  assert.match(guarded.note, /Your brand kit says/);
  const [plain] = claims(script, { products: [], domain: "general" });
  assert.deepEqual([plain.status, plain.severity], ["unsupported", "warning"]);
  // A guardrail about something else does not apply.
  assert.equal(claims(script, { products: [], rules: ["Never mention prices."], domain: "general" })[0].status, "unsupported");
});

test("advice to see a doctor is not a claim, in English or Greek", () => {
  assert.deepEqual(claims("Talk to your doctor.", { products: [], domain: "health" }), []);
  assert.deepEqual(claims("Συμβουλευτείτε τον γιατρό σας.", { products: [], domain: "health" }), []);
  assert.deepEqual(claims("Not medical advice. Δεν αποτελεί ιατρική συμβουλή.", { products: [], domain: "health" }), []);
  // Advice does not excuse a promise in the same sentence.
  assert.equal(claims("It cures colds, but talk to your doctor.", { products: [], domain: "health" })[0].status, "risky_wording");
});

test("the 3 in omega-3 names a nutrient; it is not a number to check", () => {
  const [claim] = claims("Each capsule contains 1000 mg of vitamin C and omega-3.");
  assert.equal(claim.status, "supported", "omega-3 does not count as a second number that differs from the fact");
  assert.equal(claims("Our fish oil is rich in omega-3.", { products: [], domain: "general" }).length, 0, "no number claim at all");
});

test("domain, mentions and sentences", () => {
  assert.equal(detectDomain("Fresh bread every morning.", []), "general");
  assert.equal(detectDomain("Sleep well and lower your stress.", []), "health", "two weak health terms");
  assert.equal(detectDomain("A good night's sleep.", []), "general", "one weak term is not enough");
  assert.equal(detectDomain("VitaBoost, every morning.", [VITABOOST]), "health", "a named health product decides it without health words");
  const tea = { id: "p2", name: "Calm Tea", domain: "general" as const, facts: [], hasImage: false };
  const mentions = "Pour a cup of calm tea, then a VitaBoost.";
  assert.deepEqual(productMentions(mentions, [VITABOOST, tea]), [
    { productId: "p2", index: mentions.indexOf("calm tea") },
    { productId: "p1", index: mentions.indexOf("VitaBoost") },
  ], "earliest first, case and accents ignored");
  assert.deepEqual(productMentions("VitaBoosted energy.", [VITABOOST]), [], "a name inside a longer word is not a mention");
  assert.deepEqual(splitSentences("Dr. Maria explains it. It takes 2.5 minutes! Ready? Go"), ["Dr. Maria explains it.", "It takes 2.5 minutes!", "Ready?", "Go"]);
});

test("timeAtScriptIndex uses word timings when there are some, and the script's position when not", () => {
  const script = "one two three four five six seven eight";
  const withoutWords = timeline(script);
  assert.equal(timeAtScriptIndex(script, withoutWords, script.indexOf("five")), Math.round((script.indexOf("five") / script.length) * withoutWords.durationSeconds * 10) / 10);
  const withWords = timeline(script, {}, script);
  assert.equal(timeAtScriptIndex(script, withWords, script.indexOf("five")), 1.6, "the fifth word starts at 4 × 0.4 s");
});

test("delivery: a dropped “not” is blocking, numbers must be spoken, regulated scripts need a disclaimer, avatars need the AI label", () => {
  const notAdvice = "This is not medical advice.";
  const dropped = deliveryFindings(notAdvice, timeline(notAdvice, {}, "This is medical advice."), { domain: "general" });
  const missing = dropped.find((finding) => finding.code === "words_missing")!;
  assert.equal(missing.severity, "blocking", "a dropped negation changes the meaning, even in a general script");
  assert.match(missing.message, /skips “not”.*changes the meaning/);

  const dose = "Take 2 capsules a day.";
  const general = deliveryFindings(dose, timeline(dose, {}, "Take two capsules a day."), { domain: "general" });
  assert.equal(general.find((finding) => finding.code === "number_mismatch")?.severity, "warning");
  const health = deliveryFindings(dose, timeline(dose, { labels: { aiAvatar: true, disclaimer: "Not medical advice." } }, "Take two capsules a day."), { domain: "health" });
  assert.equal(health.find((finding) => finding.code === "number_mismatch")?.severity, "blocking");
  assert.equal(health.some((finding) => finding.code === "disclaimer_missing"), false, "a disclaimer is on screen");

  const noDisclaimer = deliveryFindings(dose, timeline(dose, {}, "Take 2 capsules a day."), { domain: "health" });
  const disclaimer = noDisclaimer.find((finding) => finding.code === "disclaimer_missing")!;
  assert.equal(disclaimer.severity, "blocking");
  assert.match(disclaimer.message, /Talk to your doctor/);
  assert.match(deliveryFindings("Πάρτε μία κάψουλα.", timeline("Πάρτε μία κάψουλα."), { domain: "health" }).find((f) => f.code === "disclaimer_missing")!.message, /Συμβουλευτείτε τον γιατρό σας/);
  assert.match(deliveryFindings("Invest monthly.", timeline("Invest monthly."), { domain: "finance" }).find((f) => f.code === "disclaimer_missing")!.message, /Not financial advice/);
  assert.equal(noDisclaimer.some((finding) => finding.code === "number_mismatch" || finding.code === "words_missing"), false, "the voice matches the script");

  const labelOff = timeline(dose, { labels: { aiAvatar: false, disclaimer: "" } });
  const findings = deliveryFindings(dose, labelOff, { domain: "general" });
  assert.equal(findings.find((finding) => finding.code === "ai_label_off")?.severity, "blocking", "the item's rendered presenter is an avatar");
  assert.equal(findings.find((finding) => finding.code === "transcript_missing")?.severity, "info");
  const fileClip = { ...labelOff.video[0], source: { kind: "file" as const, fileId: "clip-1" } };
  const fromFile = { ...labelOff, video: [fileClip] };
  assert.equal(deliveryFindings(dose, fromFile, { domain: "general", avatarFileIds: ["clip-1"] }).some((f) => f.code === "ai_label_off"), true);
  assert.equal(deliveryFindings(dose, fromFile, { domain: "general", avatarFileIds: [] }).some((f) => f.code === "ai_label_off"), false, "real footage needs no AI label");
  assert.deepEqual(deliveryFindings(dose, null, { domain: "health" }), [], "no timeline, no delivery findings");
});

test("visuals: a named product must be on screen, bottom captions clash with TikTok and Reels, captions must be readable", () => {
  const script = "Mornings start with VitaBoost.";
  const base = timeline(script);
  const context = { products: [VITABOOST], productFileIds: {}, platforms: ["youtube"] };
  const notShown = visualFindings(script, base, context).find((finding) => finding.code === "product_not_shown")!;
  assert.equal(notShown.severity, "warning");
  assert.match(notShown.message, /“VitaBoost” is named at .* but its photo is not on screen/);
  const overlay = { ...base.video[0], id: "photo", layer: 1 as const, media: "image" as const, source: { kind: "file" as const, fileId: "f1" } };
  assert.equal(visualFindings(script, { ...base, video: [...base.video, overlay] }, { ...context, productFileIds: { p1: ["f1"] } }).some((f) => f.code === "product_not_shown"), false);
  const card = { id: "cta", start: 1, end: 2, kind: "cta" as const, title: "VitaBoost", subtitle: "", imageFileId: "f1" };
  assert.equal(visualFindings(script, { ...base, cards: [card] }, { ...context, productFileIds: { p1: ["f1"] } }).some((f) => f.code === "product_not_shown"), false, "a closing card with the photo counts");
  assert.equal(visualFindings(script, base, { ...context, products: [{ ...VITABOOST, hasImage: false }] }).some((f) => f.code === "product_not_shown"), false, "no photo, nothing to show");

  const underUi = visualFindings(script, base, { ...context, platforms: ["tiktok"] }).find((finding) => finding.code === "captions_under_platform_ui")!;
  assert.equal(underUi.severity, "warning");
  assert.match(underUi.message, /Centre the captions/);
  assert.equal(visualFindings(script, { ...base, style: { ...base.style, captionPosition: "center" } }, { ...context, platforms: ["instagram"] }).some((f) => f.code === "captions_under_platform_ui"), false);

  const fast = { ...base, captions: [{ id: "cap-1", start: 0, end: 0.5, text: "one two three four" }] };
  const tooFast = visualFindings(script, fast, context).find((finding) => finding.code === "captions_fast")!;
  assert.match(tooFast.message, /0\.5 s, too short to read 4 words/);
  assert.deepEqual(visualFindings(script, null, context), []);
});

test("the status rule: blocking means changes; regulated means a person approves; otherwise passed", () => {
  const blocking = [{ severity: "blocking" as const }];
  const warning = [{ severity: "warning" as const }];
  assert.equal(reviewStatus("general", blocking, [], false), "needs_changes");
  assert.equal(reviewStatus("health", [], blocking, false), "needs_changes");
  assert.equal(reviewStatus("health", warning, warning, false), "needs_approval");
  assert.equal(reviewStatus("finance", [], [], false), "needs_approval");
  assert.equal(reviewStatus("general", warning, warning, false), "passed");
  assert.equal(reviewStatus("health", blocking, [], true), "approved", "an approval stands even over blocking items it accepted");
  assert.equal(blockingCount({ claims: [...blocking, ...warning] as never, findings: [...blocking, ...blocking] as never }), 3);
});
