import { z } from "zod";

/**
 * Zod builds a faster parser with `new Function` when it can, and probes for that by trying once. Our CSP forbids
 * eval, so the probe always fails, harmlessly, but Chrome still reports every attempt as a CSP violation (the
 * DevTools Issues panel, Lighthouse Best Practices). `jitless` skips the probe; parsing is unchanged, because the
 * CSP already rules the fast path out. This module must be the browser entry's first import: zod decides when each
 * object schema is built.
 */
z.config({ jitless: true });
