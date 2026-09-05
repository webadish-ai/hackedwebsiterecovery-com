export const STOREFRONT_EVENTS = [
  'view_plan',
  'select_plan',
  'begin_checkout',
  'payment_confirmed',
  'onboarding_started',
  'credentials_completed',
] as const;

export type StorefrontEvent = (typeof STOREFRONT_EVENTS)[number];

/** Event names only. Never pass URLs, form fields, order details, or identifiers. */
export function trackStorefrontEvent(event: StorefrontEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('storefront_event', { detail: { event } }));
  if (typeof window.gtag === 'function') window.gtag('event', event);
}
