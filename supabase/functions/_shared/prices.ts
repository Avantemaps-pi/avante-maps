import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Server-side USD price table for subscription tiers (source of truth).
export const SUBSCRIPTION_USD_PRICES: Record<string, { monthly: number; annual: number }> = {
  'individual': { monthly: 0, annual: 0 },
  'small-business': { monthly: 5, annual: 48 },
  'organization': { monthly: 10, annual: 96 },
};

export type ExpectedPlanPi =
  | { ok: true; expectedPi: number }
  | { ok: false; error: 'invalid_tier' | 'price_unavailable' };

/** The Pi amount a paid plan costs now, from the price table and pi_price */
export async function getExpectedPlanPi(
  supabase: SupabaseClient,
  tier: string,
  frequency: 'monthly' | 'annual',
): Promise<ExpectedPlanPi> {
  const usdPrice = Object.hasOwn(SUBSCRIPTION_USD_PRICES, tier) ? SUBSCRIPTION_USD_PRICES[tier]?.[frequency] : undefined;
  if (usdPrice == null || usdPrice <= 0) return { ok: false, error: 'invalid_tier' };

  const { data: priceRow, error: priceErr } = await supabase
    .from('pi_price').select('price_usd').limit(1).maybeSingle();
  const piUsd = Number(priceRow?.price_usd ?? 0);
  if (priceErr || !Number.isFinite(piUsd) || piUsd <= 0) return { ok: false, error: 'price_unavailable' };

  return { ok: true, expectedPi: usdPrice / piUsd };
}
