import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepSpring, shouldDismiss } from '../apps/web/src/lib/sheet-motion';

test('sheet spring settles without overshoot and can reverse from its current velocity', () => {
  let state = { position: 120, velocity: 0 };
  for (let frame = 0; frame < 90; frame++) {
    state = stepSpring(state.position, state.velocity, 0, 1 / 60);
    assert.ok(state.position >= 0);
  }
  assert.ok(state.position < .01);
  let closing = stepSpring(120, 450, 800, 1 / 60);
  const interrupted = stepSpring(closing.position, closing.velocity, 0, 0);
  assert.deepEqual(interrupted, closing);
  for (let frame = 0; frame < 90; frame++) closing = stepSpring(closing.position, closing.velocity, 0, 1 / 60);
  assert.ok(Math.abs(closing.position) < .01);
});

test('dismissal projects release momentum, supports reversal, and rejects taps', () => {
  assert.equal(shouldDismiss(5, 2500, 800), false);
  assert.equal(shouldDismiss(170, 0, 800), true);
  assert.equal(shouldDismiss(60, 1300, 800), true);
  assert.equal(shouldDismiss(100, -500, 800), false);
  assert.equal(shouldDismiss(60, 0, 800), false);
});
