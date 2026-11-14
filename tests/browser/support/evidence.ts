import { test } from '@playwright/test';
/**
 * Where a spec saves a screenshot. The default suites write the committed evidence; the browser matrix
 * (tests/browser/browsers.config.ts) sets FACEFUL_PRIVATE_EVIDENCE so each engine writes into its own test
 * output folder instead and never replaces the evidence another engine produced.
 */
export function evidence(file: string, folder = 'docs/demo/evidence/creative-director') {
  return process.env.FACEFUL_PRIVATE_EVIDENCE ? test.info().outputPath(file) : `${folder}/${file}`;
}
