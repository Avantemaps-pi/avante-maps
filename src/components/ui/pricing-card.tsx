import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Check, X, Info, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePiPrice } from "@/hooks/usePiPrice";

export interface PricingTier {
  id: string;
  name: string;
  description: string;
  price: {
    monthly: number | string;
    yearly: number | string;
  };
  features: string[];
  limitations?: string[];
  cta: string;
  highlighted?: boolean;
  popular?: boolean;
  comingSoon?: boolean;
}

interface PricingCardProps {
  tier: PricingTier;
  paymentFrequency: string;
  id?: string;
  onSubscribe?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  isCurrentPlan?: boolean;
}

export function PricingCard({
  tier,
  paymentFrequency,
  id,
  onSubscribe,
  isLoading: isSubscribing,
  disabled,
  isCurrentPlan
}: PricingCardProps) {
  const {
    convertUsdToPiRoundedUp,
    isLoading: isPriceLoading,
    error: piPriceError,
    refresh: refreshPrice
  } = usePiPrice();

  const price = tier.price[paymentFrequency as keyof typeof tier.price];
  const isCustom = typeof price === "string";
  const isFree = price === 0;
  // usePiPrice falls back to a made-up rate when pi_price can't be read, so that rate isn't shown
  const piPrice = isFree ? "0" : typeof price === "number" && !piPriceError ? convertUsdToPiRoundedUp(price) : null;
  const priceUnavailable = !isCustom && !isFree && !isPriceLoading && piPrice === null;
  const monthly = tier.price.monthly;
  const yearlySavingPercent =
    paymentFrequency === "yearly" && typeof price === "number" && typeof monthly === "number" && monthly > 0
      ? Math.round((1 - price / (monthly * 12)) * 100)
      : 0;

  return (
    <div id={id} className="">
      {tier.popular && (
        <div className="absolute -top-3 left-8 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
          Most popular
        </div>
      )}

      <div className="space-y-6">
        <div>
          <h3 className="text-2xl font-semibold text-foreground">{tier.name}</h3>
          <p className="mt-2 text-muted-foreground">{tier.description}</p>
        </div>
        
        <div className="flex flex-col gap-1">
          {isCustom ? (
            <span className="text-5xl font-bold tracking-tight text-foreground">{price}</span>
          ) : piPrice ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline flex-wrap gap-x-2">
                <span className="text-5xl font-bold tracking-tight text-foreground">
                  π {piPrice}
                </span>
                <span className="text-base font-normal text-muted-foreground">
                  / {paymentFrequency}
                </span>
              </div>
              {yearlySavingPercent > 0 && (
                <span className="text-sm font-medium text-primary">Save {yearlySavingPercent}%</span>
              )}
            </div>
          ) : priceUnavailable ? (
            <div className="flex items-center gap-3" role="status">
              <span className="text-base text-muted-foreground">Price unavailable</span>
              <Button type="button" variant="outline" size="sm" onClick={() => refreshPrice()}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                Retry
              </Button>
            </div>
          ) : (
            <Skeleton className="h-12 w-40" aria-label="Loading price" />
          )}
        </div>

        <ul className="space-y-4">
          {tier.features.map(feature => (
            <li key={feature} className="flex items-center gap-3">
              <Check className="h-5 w-5 flex-shrink-0 text-primary" />
              <span className="text-foreground">{feature}</span>
            </li>
          ))}
          {tier.limitations?.map(limitation => (
            <li key={limitation} className="flex items-center gap-3">
              <X className="h-5 w-5 flex-shrink-0 text-input" />
              <span className="text-muted-foreground italic">{limitation}</span>
            </li>
          ))}
        </ul>

        {tier.id === 'individual' && (
          <div className="flex items-start gap-2 rounded-md bg-secondary border border-secondary p-3 text-sm text-secondary-foreground">
            <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-secondary-foreground" />
            <span>Need more than 1 listing? Upgrade to Small Business for up to 3.</span>
          </div>
        )}
      </div>

      <Button
        variant={isCurrentPlan ? "outline" : "default"}
        className={cn(
          "mt-8 w-full text-base py-6",
          isCurrentPlan && "border-primary text-primary hover:bg-primary/10"
        )}
        data-plan-button={tier.id}
        onClick={onSubscribe}
        disabled={isSubscribing || disabled}
      >
        {isSubscribing ? "Processing..." : isCurrentPlan ? "Current Plan" : tier.cta}
      </Button>
    </div>
  );
}
