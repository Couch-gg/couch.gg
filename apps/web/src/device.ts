// Treat tablets/laptops as desktop/TV: only true phones get the phone-first UI.
export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const narrow = window.innerWidth <= 820;
  return ua || (coarse && narrow);
}
