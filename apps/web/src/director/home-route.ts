import { isExactInstruction } from './model';

/**
 * Where a request typed in the home composer goes. One new video opens the guided New project flow with the
 * composer's settings; everything else (a campaign of several videos, finding or showing content, exact edits,
 * changes to a draft, questions, billing, scheduling) goes to the Creative Director.
 *
 * Deterministic on purpose: it runs on every send, offline and without a model, and the same words always go to
 * the same place. When in doubt it picks the Director, which can still answer or draft from anything.
 */
export type HomeRoute = 'new-project' | 'director';

const VIDEO = /\b(video|reel|short|tiktok|clip|explainer|promo|teaser|trailer|ad|advert|intro|introduction|tutorial|testimonial|announcement|story|vlog|walkthrough|demo)\b/i;
const DURATION = /\b\d{1,3}\s*(?:-\s*)?(?:s|secs?|seconds?|mins?|minutes?)\b/i;
/** Verbs that start a new video. */
const MAKE = /^(?:please\s+)?(?:create|make|generate|produce|draft|write|film|shoot|record|build|start)\b/i;
/** Requests about what already exists, or for a change to it. */
const ACT = /^(?:please\s+)?(?:find|search|show|list|open|play|review|schedule|publish|post|render|regenerate|upgrade|buy|subscribe|check|undo|delete|remove|rename|translate|shorten|lengthen|change|edit|rewrite|fix|update|set|use|enable|disable|hide|add|replace|tweak|improve)\b/i;
const QUESTION = /^(?:how|what|why|when|where|which|who|can|could|do|does|did|is|are|should|would|will|have|has)\b/i;
/** Several videos at once, or a plan over time: that is a campaign for the Director. */
const SEVERAL = /\b(?:campaign|series|calendar|content plan|posting plan)\b|\b(?:two|three|four|five|six|seven|several|multiple|a few|some|\d+)\s+(?:[\w’'-]+\s+){0,2}(?:videos|reels|shorts|tiktoks|clips|posts|ads)\b/i;

export function routeHomeRequest(text: string): HomeRoute {
  const ask = text.trim().replace(/\s+/g, ' ');
  if (!ask || isExactInstruction(ask) || /\?$/.test(ask) || QUESTION.test(ask)) return 'director';
  if (/^plan\b/i.test(ask) || SEVERAL.test(ask)) return 'director';
  // "Make the hook shorter" changes a draft; "Make a video about…" starts one.
  if (MAKE.test(ask)) return /^(?:please\s+)?make\s+(?:the|this|that|it|my|our)\b/i.test(ask) && !VIDEO.test(ask) ? 'director' : 'new-project';
  if (ACT.test(ask)) return 'director';
  // A description of one video: "A 15-second Reel introducing our spring menu".
  return VIDEO.test(ask) || DURATION.test(ask) ? 'new-project' : 'director';
}
