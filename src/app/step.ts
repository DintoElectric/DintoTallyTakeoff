/** Which one to go to when stepping through a list: from nothing selected, the first (or last going back); otherwise the next, wrapping round. */
export function stepIndex(length: number, current: number, dir: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : length - 1;
  return (current + dir + length) % length;
}
