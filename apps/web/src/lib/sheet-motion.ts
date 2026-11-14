/** Critically damped spring, evaluated from its current position/velocity.
 * Response .3s follows the Apple-design drawer guidance; no animation dependency.
 */
export function stepSpring(position: number, velocity: number, target: number, seconds: number) {
  const omega = 2 * Math.PI / .3;
  const distance = position - target;
  const c = velocity + omega * distance;
  const decay = Math.exp(-omega * seconds);
  return {
    position: target + (distance + c * seconds) * decay,
    velocity: (velocity - omega * c * seconds) * decay,
  };
}
export function shouldDismiss(position: number, velocity: number, height: number) {
  // Project .99 exponential deceleration; an upward reversal cancels a small drag.
  const projected = position + (velocity / 1000) * .99 / (1 - .99);
  return position > 12 && projected > Math.min(160, height * .25);
}
