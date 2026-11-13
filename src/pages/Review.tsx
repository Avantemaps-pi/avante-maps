import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from '@/lib/router-compat';
import { hasInAppHistory } from '@/lib/inAppHistory';
import AppLayout from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StarIcon, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import ReviewList from '@/components/reviews/ReviewList';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuth } from '@/context/auth';
import { supabase } from '@/integrations/supabase/client';
import { Place } from '@/types/business';
import { useReviewSubmission } from '@/hooks/useReviewSubmission';
import { useReviewStats } from '@/hooks/useReviewStats';
import { getSessionUserId } from '@/lib/sessionUserId';
import { StateBlock } from '@/components/ui/state-block';
import LoginDialog from '@/components/auth/LoginDialog';

const MAX_REVIEW_LENGTH = 2000;
// How long a cached sign-in may take to restore after a direct page load
const RESTORE_WAIT_MS = 3000;

const Review = () => {
  const { businessId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isLoading } = useAuth();
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [review, setReview] = useState('');
  const isMobile = useIsMobile();
  const [business, setBusiness] = useState<Place | null>(null);
  const [businessLoading, setBusinessLoading] = useState(true);
  const [existingReviewLoaded, setExistingReviewLoaded] = useState(false);
  // ?tab=reviews (the new-review notification's link) opens on View Reviews. Left in the URL, so
  // Back and a reload keep the tab
  const [activeTab, setActiveTab] = useState(() =>
    new URLSearchParams(location.search.replace(/^\?+/, '')).get('tab') === 'reviews' ? 'reviews' : 'review'
  );
  const reviewStats = useReviewStats();
  const [showLogin, setShowLogin] = useState(false);
  // AuthProvider restores a cached sign-in after hydration, so on a direct
  // load user is briefly null; wait for it before showing the signed-out state
  const [restoreWindowOver, setRestoreWindowOver] = useState(false);
  
  const { submitReview, fetchUserReview, isSubmitting } = useReviewSubmission({
    onSuccess: () => {
      setTimeout(() => handleGoBack(), 1500);
    },
  });

  useEffect(() => {
    let hasCachedSignIn = false;
    try {
      hasCachedSignIn = !!localStorage.getItem('avante_maps_auth');
    } catch {
      // storage unavailable — nothing to restore
    }
    if (!hasCachedSignIn) {
      setRestoreWindowOver(true);
      return;
    }
    const timer = setTimeout(() => setRestoreWindowOver(true), RESTORE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  
  // Load business data from state or fetch from database
  useEffect(() => {
    const loadBusiness = async () => {
      // First try to use state passed from navigation
      const businessDetails = (location.state as any)?.businessDetails;
      if (businessDetails) {
        setBusiness(businessDetails);
        setBusinessLoading(false);
        return;
      }

      // If no state and we have a businessId, fetch from database
      if (businessId) {
        try {
          // Use the SECURITY DEFINER RPC so sensitive fields (pi_wallet_address)
          // are never exposed; this also works for non-owners viewing the page.
          const sessionUserId = await getSessionUserId();
          const { data: rows, error } = await supabase
            .rpc('get_public_business_info', sessionUserId ? { user_uuid: sessionUserId } : {});

          if (error) throw error;
          const data = (rows ?? []).find((r: any) => r.id === parseInt(businessId));

          if (data) {
            const contactInfo = data.contact_info as { phone?: string; website?: string } | null;

            const addressParts = [
              data.street_address,
              data.city,
              data.state,
              data.postal_code,
              data.country
            ].filter(Boolean);
            const fullAddress = addressParts.join(', ') || data.location || '';

            const place: Place = {
              id: data.id.toString(),
              name: data.name,
              position: { lat: data.latitude || 0, lng: data.longitude || 0 },
              address: fullAddress,
              streetAddress: data.street_address || undefined,
              city: data.city || undefined,
              state: data.state || undefined,
              postalCode: data.postal_code || undefined,
              country: data.country || undefined,
              rating: 0,
              totalReviews: 0,
              category: data.business_types?.join(', ') || data.category || '',
              description: data.description || '',
              image: data.images?.[0] || undefined,
              images: data.images || undefined,
              phone: contactInfo?.phone || undefined,
              website: contactInfo?.website || undefined,
              hours: data.hours as Place['hours'] || undefined,
              isVerified: data.is_verified || false,
              isCertified: data.is_certified || false,
              verificationStatus: (data.verification_status as Place['verificationStatus']) || undefined,
              business_types: data.business_types || undefined,
            };
            setBusiness(place);
          }
        } catch (error) {
          console.error('Error fetching business:', error);
          toast.error('Failed to load business details');
        }
      }
      setBusinessLoading(false);
    };

    loadBusiness();
  }, [businessId, location.state]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Safe back navigation - falls back to recommendations if no history
  const handleGoBack = () => {
    if (hasInAppHistory()) {
      navigate(-1);
    } else {
      navigate('/recommendations');
    }
  };

  // Load existing review if user has one
  useEffect(() => {
    const loadExistingReview = async () => {
      if (!user?.uid || !businessId || existingReviewLoaded) return;
      
      const existingReview = await fetchUserReview(parseInt(businessId));
      if (existingReview) {
        setRating(existingReview.rating);
        setReview(existingReview.content || '');
      }
      setExistingReviewLoaded(true);
    };

    loadExistingReview();
  }, [user?.uid, businessId, existingReviewLoaded, fetchUserReview]);

  const handleSubmitReview = async () => {
    if (rating === 0) {
      toast.error("Please select a rating before submitting");
      return;
    }

    if (review.length > MAX_REVIEW_LENGTH) {
      toast.error(`Review must be less than ${MAX_REVIEW_LENGTH} characters`);
      return;
    }

    if (!user?.uid || !businessId) {
      toast.error("Unable to submit review. Please try again.");
      return;
    }

    await submitReview(
      {
        rating,
        content: review.trim() || undefined,
        businessId: parseInt(businessId),
      }
    );
  };

  // Show loading state while a cached sign-in may still be restoring
  // If user is already set, skip the auth loading screen
  if (!user && (isLoading || !restoreWindowOver)) {
    return (
      <AppLayout 
        title="Write a Review"
        hideBottomNav={true}
        backButton={true}
        fullHeight={false}
        fullWidth={true}
        className="px-0"
      >
        <div className="w-full h-[50vh] flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!user) {
    return (
      <AppLayout 
        title="Write a Review"
        hideBottomNav={true}
        backButton={true}
        fullHeight={false}
        fullWidth={true}
        className="px-0"
      >
        <div className="w-full px-4 flex items-center justify-center min-h-[60vh]">
          <StateBlock
            kind="empty"
            icon={Lock}
            title="Sign in to write a review"
            body="Reviews are written by signed-in Pi Network users."
            action={{ label: 'Sign in with Pi', onClick: () => setShowLogin(true) }}
          />
          <LoginDialog open={showLogin} onOpenChange={setShowLogin} />
        </div>
      </AppLayout>
    );
  }

  // Show loading while fetching business data
  if (businessLoading) {
    return (
      <AppLayout 
        title="Write a Review"
        hideBottomNav={true}
        backButton={true}
        fullHeight={false}
        fullWidth={true}
        className="px-0"
      >
        <div className="w-full h-[50vh] flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-muted-foreground">Loading business details...</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  // Show error if business not found
  if (!business) {
    return (
      <AppLayout 
        title="Business Not Found"
        hideBottomNav={true}
        backButton={true}
        fullHeight={false}
        fullWidth={true}
        className="px-0"
      >
        <div className="w-full h-[50vh] flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-muted-foreground">Business not found</p>
            <Button onClick={handleGoBack}>Go Back</Button>
          </div>
        </div>
      </AppLayout>
    );
  }

  const businessStats = reviewStats.get(business.id);

  return (
    <AppLayout 
      title="Write a Review"
      hideBottomNav={true}
      backButton={true}
      fullHeight={false}
      fullWidth={true}
      className="px-0"
    >
      <div className="w-full pb-8 px-4 pt-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full mb-4 h-auto">
            <TabsTrigger value="review" className="flex-1 min-h-11 text-sm">Write Review</TabsTrigger>
            <TabsTrigger value="reviews" className="flex-1 min-h-11 text-sm">View Reviews</TabsTrigger>
          </TabsList>
          
          <TabsContent value="review" className="w-full">
            <Card className={`${isMobile ? 'mt-4' : 'mt-8'} w-full`}>
              <CardHeader>
                <div className="flex items-center gap-4 mb-6">
                  <div className="h-16 w-16 rounded-md overflow-hidden">
                    <img 
                      src={business.image} 
                      alt={business.name} 
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        e.currentTarget.src = '/placeholder.svg';
                      }}
                    />
                  </div>
                  <div>
                    <CardTitle className="text-xl">{business.name}</CardTitle>
                    <div className="flex flex-col items-start mt-1">
                      <div className="flex items-center">
                        {[...Array(5)].map((_, i) => (
                          <StarIcon
                            key={i}
                            className={`h-4 w-4 ${
                              i < Math.floor(businessStats?.rating || 0)
                                ? 'text-primary fill-primary'
                                : 'text-input'
                            }`}
                          />
                        ))}
                        <span className="text-sm ml-1">{(businessStats?.rating || 0).toFixed(1)}</span>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        ({businessStats?.totalReviews || 0} reviews)
                      </span>
                    </div>
                  </div>
                </div>
              </CardHeader>
              
              <CardContent>
                <div className="mb-6">
                  <h3 className="text-lg font-medium mb-3">Your Rating</h3>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setRating(star)}
                        onMouseEnter={() => setHoverRating(star)}
                        onMouseLeave={() => setHoverRating(0)}
                        className="p-1 rounded-full hover:bg-accent transition-colors"
                      >
                        <StarIcon
                          className={`h-8 w-8 ${
                            star <= (hoverRating || rating)
                              ? 'text-primary fill-primary'
                              : 'text-input'
                          }`}
                        />
                      </button>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">
                    {rating > 0 ? (
                      <span className="font-medium">
                        {rating === 5 ? "Excellent! " : rating === 4 ? "Great! " : rating === 3 ? "Good. " : rating === 2 ? "Fair. " : "Poor. "}
                        {rating === 1 
                          ? "We're sorry to hear about your experience." 
                          : rating <= 3 
                          ? "Thank you for your feedback."
                          : "We're glad you enjoyed your experience!"}
                      </span>
                    ) : (
                      "Tap a star to rate"
                    )}
                  </p>
                </div>
                
                <div className="mb-6">
                  <div className="flex justify-between items-center mb-3">
                    <h3 className="text-lg font-medium">Your Review (optional)</h3>
                    <span className={`text-sm ${review.length > MAX_REVIEW_LENGTH ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {review.length}/{MAX_REVIEW_LENGTH}
                    </span>
                  </div>
                  <Textarea
                    placeholder="Share your experience with this business..."
                    className="min-h-32"
                    value={review}
                    onChange={(e) => setReview(e.target.value)}
                    maxLength={MAX_REVIEW_LENGTH + 100} // Allow slight overflow for UX, validate on submit
                    disabled={isSubmitting}
                  />
                </div>
                
                <div className="flex justify-end space-x-2">
                  <Button variant="outline" onClick={handleGoBack} disabled={isSubmitting}>
                    Cancel
                  </Button>
                  <Button onClick={handleSubmitReview} disabled={isSubmitting || rating === 0}>
                    {isSubmitting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      existingReviewLoaded && rating > 0 ? 'Update Review' : 'Submit Review'
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          
          <TabsContent value="reviews" className="w-full">
            <ReviewList businessId={business.id} onWriteReview={() => setActiveTab('review')} />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
};

export default Review;
