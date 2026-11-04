
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export const usePiPrice = () => {
  const [piPrice, setPiPrice] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPiPrice = useCallback(async () => {
    try {
      // Fetch cached Pi price from database (updated every 24 hours)
      const { data, error: fetchError } = await supabase
        .from('pi_price')
        .select('price_usd, updated_at')
        .eq('id', 1)
        .single();

      if (fetchError) throw fetchError;

      if (data) {
        const priceValue = typeof data.price_usd === 'string'
          ? parseFloat(data.price_usd)
          : data.price_usd;
        setPiPrice(priceValue);
        setError(null);
      } else {
        throw new Error('No price data available');
      }
    } catch (err) {
      console.error('Error fetching Pi price from database:', err);
      // Fallback to default price
      setPiPrice((current) => current ?? 0.65);
      setError('Using fallback Pi price');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPiPrice();
    // Refresh from database every 5 minutes to get the latest cached price
    const interval = setInterval(fetchPiPrice, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchPiPrice]);

  const convertUsdToPi = (usdAmount: number) => {
    if (!piPrice) return null;
    return (usdAmount / piPrice).toFixed(2);
  };

  // Rounded up: what a Pi Wallet payment asks for, so rounding can't put it under the server's price.
  // The toFixed drops float noise, or an exact 65.19 would become 65.20
  const convertUsdToPiRoundedUp = (usdAmount: number) => {
    if (!piPrice) return null;
    return (Math.ceil(Number(((usdAmount / piPrice) * 100).toFixed(6))) / 100).toFixed(2);
  };

  return { piPrice, isLoading, error, convertUsdToPi, convertUsdToPiRoundedUp, refresh: fetchPiPrice };
};
