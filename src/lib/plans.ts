export const GST_RATE_PERCENT = 18;
export const PLAN_VERSION = '2026-09-05';

export type Billing = 'one_time' | 'annual_upfront' | 'monthly';

export interface Plan {
  id: 'recovery' | 'recovery-care' | 'agency-care';
  name: string;
  eyebrow: string;
  description: string;
  pricePaise: number;
  billing: Billing;
  billingLabel: string;
  siteAllowance: string;
  inclusions: string[];
  exclusions: string[];
  featured?: boolean;
  actionLabel: string;
}

export const PLANS: readonly Plan[] = [
  {
    id: 'recovery',
    name: 'Recovery',
    eyebrow: 'One standard incident',
    description: 'A careful cleanup and recovery for one standard WordPress site.',
    pricePaise: 799900,
    billing: 'one_time',
    billingLabel: 'One-time payment',
    siteAllowance: '1 WordPress site',
    inclusions: ['Pre-change snapshot', 'Malware cleanup and hardening', 'Recovery findings report', '30-day follow-up'],
    exclusions: ['Complex WooCommerce or custom applications', 'Missing-data restoration', 'Hosting-account compromise'],
    actionLabel: 'Choose Recovery',
  },
  {
    id: 'recovery-care',
    name: 'Recovery + Care',
    eyebrow: 'Most requested',
    description: 'Initial recovery plus a year of monitoring and one additional standard incident.',
    pricePaise: 1499900,
    billing: 'annual_upfront',
    billingLabel: 'Annual, paid upfront',
    siteAllowance: '1 WordPress site',
    inclusions: ['Initial standard cleanup', 'Monitoring and reports', 'One additional standard incident in term', '30-day follow-up per cleanup'],
    exclusions: ['Complex WooCommerce or custom applications', 'Missing-data restoration', 'Hosting-account compromise'],
    featured: true,
    actionLabel: 'Choose Recovery + Care',
  },
  {
    id: 'agency-care',
    name: 'Agency Care',
    eyebrow: 'For agencies and hosts',
    description: 'Portfolio monitoring and reports for teams managing several WordPress sites.',
    pricePaise: 499900,
    billing: 'monthly',
    billingLabel: 'Monthly PayU mandate',
    siteAllowance: 'Up to 10 WordPress sites',
    inclusions: ['Portfolio monitoring', 'Regular security reports', 'Priority recovery coordination', 'Human support for your team'],
    exclusions: ['Recovery work is bought separately', 'Cross-site infection', 'Custom applications or missing-data restoration'],
    actionLabel: 'Choose Agency Care',
  },
];

export function getPlan(id: string | null | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

export function formatINR(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(paise / 100);
}

export function calculatePrice(plan: Plan, quantity = 1) {
  const safeQuantity = Number.isInteger(quantity) ? Math.max(1, Math.min(quantity, plan.id === 'recovery' ? 10 : 1)) : 1;
  const subtotalPaise = plan.pricePaise * safeQuantity;
  const gstPaise = Math.round((subtotalPaise * GST_RATE_PERCENT) / 100);
  return {
    quantity: safeQuantity,
    subtotalPaise,
    gstPaise,
    totalPaise: subtotalPaise + gstPaise,
    gstRatePercent: GST_RATE_PERCENT,
  };
}

export function isValidWebsite(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
