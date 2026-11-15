import { test } from "node:test";
import assert from "node:assert/strict";
import { countBlinks, createPhraseTracker, evaluateLiveness, largestJump, lipSyncScore, pearson, phraseCoverage, voicedMs, type FaceFrame } from "../apps/web/src/likeness/checks";
import { boxOnScreen, faceFit } from "../apps/web/src/likeness/fit";
import { consentStatement, pickPhrases } from "../apps/web/src/likeness/phrases";
import { createHoldTimer, matchesPose, poseFromMatrix, poseSequence, type PoseId } from "../apps/web/src/likeness/pose";
import { createReadAlongSync } from "../apps/web/src/likeness/sync";

/** The pure half of the face scan: head pose, the oval fit, the phrases and the liveness checks. */

/** Column-major 4x4 for a head turned by yaw (about y) then pitched (about x), in degrees. */
function matrix(yawDeg: number, pitchDeg: number): number[] {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  // R = Ry(yaw) * Rx(-pitch): +pitch tilts the face's forward vector up (+y).
  const ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const rx = [[1, 0, 0], [0, Math.cos(-p), -Math.sin(-p)], [0, Math.sin(-p), Math.cos(-p)]];
  const r = ry.map((row) => [0, 1, 2].map((c) => row.reduce((sum, value, k) => sum + value * rx[k][c], 0)));
  const data = new Array(16).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) data[col * 4 + row] = r[row][col];
  data[15] = 1;
  return data;
}
const near = (actual: number, expected: number, tolerance = 0.5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
const ALL: PoseId[] = ["center", "left", "right", "up", "down"];

test("head pose is read from the transformation matrix and judged against the straight baseline", () => {
  const pose = poseFromMatrix(matrix(30, -15));
  near(pose.yaw, 30);
  near(pose.pitch, -15);
  near(poseFromMatrix(matrix(0, 0)).yaw, 0, 1e-9);
  const baseline = poseFromMatrix(matrix(0, -10)); // camera held low
  assert.equal(matchesPose("center", poseFromMatrix(matrix(2, -5)), null), true);
  assert.equal(matchesPose("left", poseFromMatrix(matrix(28, -10)), baseline), true);
  assert.equal(matchesPose("right", poseFromMatrix(matrix(28, -10)), baseline), false);
  assert.equal(matchesPose("right", poseFromMatrix(matrix(-25, -8)), baseline), true);
  assert.equal(matchesPose("up", poseFromMatrix(matrix(0, 5)), baseline), true);
  assert.equal(matchesPose("down", poseFromMatrix(matrix(0, -12)), baseline), false);
  assert.equal(matchesPose("down", poseFromMatrix(matrix(0, -26)), baseline), true);
});

test("the scan starts straight, shuffles the four turns, and needs each pose held without a break", () => {
  const sequence = poseSequence(() => 0);
  assert.equal(sequence[0], "center");
  assert.deepEqual([...sequence].sort(), [...ALL].sort());
  // A replayed video cannot know the order: it changes from scan to scan.
  assert.ok(new Set(Array.from({ length: 40 }, () => poseSequence().join())).size > 5);
  const hold = createHoldTimer(400);
  assert.equal(hold.update(true, 0), false);
  assert.equal(hold.update(true, 300), false);
  assert.equal(hold.update(false, 350), false);
  assert.equal(hold.update(true, 400), false);
  assert.equal(hold.update(true, 800), true);
});

test("the face must fill the on-screen oval: closer, back and center are told apart", () => {
  const video = { w: 1280, h: 720 };
  const view = { w: 1440, h: 900 };
  const oval = { x: 720 - 207, y: 450 - 269, w: 414, h: 538 };
  // Cover scale is 1.25 (900 / 720): the frame is 1600 wide, cropped 80 px each side, then mirrored.
  const rect = boxOnScreen([0.4, 0.3, 0.5, 0.6], video, view);
  near(rect.x, 1440 - (0.5 * 1600 - 80), 1e-6);
  near(rect.w, 160, 1e-6);
  near(rect.y, 0.3 * 900, 1e-6);
  const face = (w: number, cx = 720, cy = 450) => ({ x: cx - w / 2, y: cy - w * 0.6, w, h: w * 1.2 });
  assert.equal(faceFit(face(150), oval, false), "closer");
  assert.equal(faceFit(face(300), oval, false), "ok");
  assert.equal(faceFit(face(480), oval, false), "back");
  assert.equal(faceFit(face(300, 900), oval, false), "center");
  assert.equal(faceFit(face(200, 800), oval, true), "ok", "a turned head is narrower and off center");
});

test("the read-aloud is two different random phrases, then the consent statement in Faceful's own words", () => {
  const phrases = pickPhrases("Minas Kontis", "en");
  assert.equal(phrases.length, 3);
  assert.notEqual(phrases[0], phrases[1]);
  assert.equal(phrases[2], consentStatement("Minas Kontis", "en"));
  assert.equal(consentStatement("Minas Kontis", "en"), "I, Minas Kontis, agree that Faceful may create an avatar of my face and voice.");
  assert.match(consentStatement("  Μηνάς   Κόντης ", "el"), /^Εγώ, Μηνάς Κόντης, συμφωνώ να δημιουργήσει η Faceful/);
  // The phrases work as a one-time spoken passphrase: across scans they keep changing.
  assert.ok(new Set(Array.from({ length: 40 }, () => pickPhrases("A B", "en").slice(0, 2).join("|"))).size > 10);
});

test("phrase coverage tolerates recognizer mistakes, including the brand name heard as two words", () => {
  const statement = consentStatement("Minas Kontis", "en");
  assert.ok(phraseCoverage(statement, "I Minas Contis agree that face full may create an avatar of my face and voice") > 0.85);
  assert.ok(phraseCoverage(statement, "hello there") < 0.2);
  assert.equal(phraseCoverage("Καλημέρα σε όλους", "καλημερα σε ολους"), 1);
  // The read-along does not stall on the split name either.
  const sync = createReadAlongSync(statement);
  sync.update("I Minas Kontis agree that face full");
  assert.equal(sync.words[sync.position - 1].norm, "faceful");
  assert.equal(sync.update("I Minas Kontis agree that face full may create an avatar of my face and voice"), sync.words.length);
});

test("phrases count by everything heard along the way, not only by the last transcript a recognizer held", () => {
  const phrases = ["The quick brown fox jumps over the lazy dog.", "Bright morning sunshine warms the blue ocean.", consentStatement("Minas Kontis", "en")];
  const heard = createPhraseTracker(phrases);
  // A browser recognizer restarts mid-reading: its transcript starts again from nothing each time.
  for (const snapshot of ["the quick", "the quick brown fox jumps", "the quick brown fox jumps over the lazy dog", "bright", "bright morning sunshine warms the blue ocean", "I Minas", "I Minas Kontis agree that face full may create an avatar of my face and voice"]) heard.update(snapshot);
  assert.deepEqual(heard.coverage(), [1, 1, 1]);
  const scanFrames: FaceFrame[] = Array.from({ length: 300 }, (_, i) => ({ t: i * 33, faces: 1, yaw: Math.sin(i / 30) * 30, pitch: 0, blink: i % 90 === 0 ? 0.9 : 0.1 }));
  const speechFrames: FaceFrame[] = Array.from({ length: 400 }, (_, i) => ({ t: i * 33, faces: 1, jaw: Math.abs(Math.sin(i / 5)), audio: Math.abs(Math.sin(i / 5)) * 0.2 }));
  const evidence = { posesCaptured: ALL, scanFrames, speechFrames, phrases, speechMs: 30_000, transcript: "I Minas Kontis agree that Faceful may create an avatar of my face and voice" };
  // The last transcript alone holds only the third phrase: that is the capture that used to fail.
  assert.equal(evaluateLiveness(evidence).checks.find((check) => check.id === "phrases")?.passed, false);
  assert.equal(evaluateLiveness({ ...evidence, phraseCoverage: heard.coverage() }).passed, true);
  // Words nobody heard still count against it: a phrase skipped is a phrase not spoken.
  const skipped = createPhraseTracker(phrases);
  skipped.update("the quick brown fox jumps over the lazy dog");
  skipped.update("I Minas Kontis agree that Faceful may create an avatar of my face and voice");
  assert.ok(skipped.coverage()[1] < 0.5);
  assert.equal(evaluateLiveness({ ...evidence, phraseCoverage: skipped.coverage() }).passed, false);
});

test("blinks, cuts and lip sync are measured from the tracked frames", () => {
  const frames = (values: Partial<FaceFrame>[]): FaceFrame[] => values.map((value, i) => ({ t: i * 33, faces: 1, ...value }));
  assert.equal(countBlinks(frames([{ blink: 0.1 }, { blink: 0.7 }, { blink: 0.6 }, { blink: 0.1 }, { blink: 0.8 }])), 2);
  assert.equal(largestJump(frames([{ yaw: 0, pitch: 0 }, { yaw: 3, pitch: 0 }, { yaw: 45, pitch: 0 }])), 42);
  const speaking = frames(Array.from({ length: 120 }, (_, i) => ({ jaw: Math.abs(Math.sin(i / 4)), audio: Math.abs(Math.sin(i / 4)) * 0.2 + 0.01 })));
  assert.ok(lipSyncScore(speaking) > 0.9);
  const offCamera = frames(Array.from({ length: 120 }, (_, i) => ({ jaw: 0.05, audio: Math.abs(Math.sin(i / 4)) * 0.2 })));
  assert.ok(lipSyncScore(offCamera) < 0.2, "someone off camera reading does not move the mouth in view");
  near(pearson([1, 2, 3], [2, 4, 6]), 1, 1e-9);
  // Voiced time counts only frames above the noise floor, and ignores a stall in tracking.
  assert.equal(voicedMs(frames(Array.from({ length: 101 }, () => ({ audio: 0.08 })))), 3300);
  assert.equal(voicedMs(frames(Array.from({ length: 101 }, () => ({ audio: 0.004 })))), 0);
  assert.equal(voicedMs([{ t: 0, faces: 1, audio: 0.1 }, { t: 33, faces: 1, audio: 0.1 }, { t: 5000, faces: 1, audio: 0.1 }]), 33);
  // The voice level trails the frame by the tracking time; a few frames of delay must still count as in sync.
  const delayed = frames(Array.from({ length: 150 }, (_, i) => ({ jaw: Math.abs(Math.sin(i / 3)), audio: Math.abs(Math.sin((i - 3) / 3)) * 0.2 })));
  assert.ok(lipSyncScore(delayed) > 0.9);
});

test("a good capture passes; a missing angle or an unspoken consent blocks; advisory checks only report", () => {
  const scanFrames: FaceFrame[] = Array.from({ length: 300 }, (_, i) => ({ t: i * 33, faces: 1, yaw: Math.sin(i / 30) * 30, pitch: 0, blink: i % 90 === 0 ? 0.9 : 0.1 }));
  const speechFrames: FaceFrame[] = Array.from({ length: 400 }, (_, i) => ({ t: i * 33, faces: 1, jaw: Math.abs(Math.sin(i / 5)), audio: Math.abs(Math.sin(i / 5)) * 0.2 }));
  const phrases = pickPhrases("Minas Kontis", "en");
  const good = { posesCaptured: ALL, scanFrames, speechFrames, phrases, transcript: phrases.join(" "), speechMs: 30_000 };
  assert.equal(evaluateLiveness(good).passed, true);
  assert.equal(evaluateLiveness({ ...good, posesCaptured: ["center", "left", "right", "up"] }).passed, false);
  const unspoken = evaluateLiveness({ ...good, transcript: phrases.slice(0, 2).join(" ") });
  assert.equal(unspoken.passed, false);
  assert.equal(unspoken.checks.find((check) => check.id === "phrases")?.passed, false);
  assert.equal(evaluateLiveness({ ...good, speechMs: 3000 }).passed, false, "too little speech to learn a voice from");
  const still = evaluateLiveness({ ...good, speechFrames: speechFrames.map((frame) => ({ ...frame, jaw: 0.1 })) });
  assert.equal(still.checks.find((check) => check.id === "lip_sync")?.passed, false);
  assert.equal(still.passed, true);
});
