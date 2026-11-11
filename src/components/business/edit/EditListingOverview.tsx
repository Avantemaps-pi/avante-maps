import React from 'react';
import { ChevronRight, ExternalLink, Store } from 'lucide-react';
import { Link } from '@/lib/router-compat';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/auth';
import { cn } from '@/lib/utils';
import { Business } from '@/types/business';
import {
  LISTING_SECTIONS,
  listingStatus,
  sectionSummary,
} from './listingSections';

interface EditListingOverviewProps {
  business: Business;
}

// Edit listing: the business at the top, then one row per section; a row opens that section
const EditListingOverview: React.FC<EditListingOverviewProps> = ({
  business,
}) => {
  const { user } = useAuth();
  const photo = business.images?.[0];
  const status = listingStatus(business);

  return (
    <div className="w-full space-y-5 py-2">
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {photo ? (
            <img src={photo} alt="" className="h-full w-full object-cover" />
          ) : (
            <Store
              className="h-7 w-7 text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-tight">
            {business.name}
          </h2>
          {user?.username && (
            <p className="truncate text-sm text-muted-foreground">
              Owner @{user.username}
            </p>
          )}
          <p
            className={cn(
              'mt-1 text-sm font-medium',
              status === 'Not verified yet'
                ? 'text-muted-foreground'
                : 'text-primary',
            )}
          >
            {status}
          </p>
        </div>
        <Link
          to={`/recommendations/${business.id}`}
          className="flex min-h-11 shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          View listing
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <ul
        className="divide-y overflow-hidden rounded-lg border"
        aria-label="Listing sections"
      >
        {LISTING_SECTIONS.map(({ id, title, icon: Icon }) => {
          const summary = sectionSummary(id, business);
          return (
            <li key={id}>
              <Link
                to={`/update-registration/${business.id}/${id}`}
                state={{ fromOverview: true }}
                className="flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-hidden"
              >
                <Icon
                  className="h-5 w-5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{title}</span>
                  <span
                    className={cn(
                      'block truncate text-sm text-muted-foreground',
                      id === 'wallet' && summary !== 'Not set' && 'font-mono',
                    )}
                    data-testid={`summary-${id}`}
                  >
                    {summary}
                  </span>
                </span>
                <ChevronRight
                  className="h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const EditListingOverviewSkeleton: React.FC = () => (
  <div
    className="w-full space-y-5 py-2"
    aria-busy="true"
    aria-label="Loading business information"
  >
    <div className="flex items-start gap-3">
      <Skeleton className="h-16 w-16 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/4" />
      </div>
    </div>
    <div className="divide-y rounded-lg border">
      {LISTING_SECTIONS.map(({ id }) => (
        <div key={id} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <Skeleton className="h-5 w-5 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

export default EditListingOverview;
