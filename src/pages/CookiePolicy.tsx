import React from 'react';
import AppLayout from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Link } from '@/lib/router-compat';

const CookiePolicy = () => {
  return (
    <AppLayout title="Cookie Policy">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 pb-10">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-bold">Cookie Policy</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <ScrollArea className="h-[60vh] pr-4">
              <div className="space-y-6">
                <p className="text-muted-foreground"><strong>Effective Date:</strong> November 13, 2026</p>

                <h3 className="text-lg font-medium">1. The short version</h3>
                <p>
                  Avante Maps, run by Avante Maps Pty Ltd, uses no advertising cookies, no analytics cookies and no third-party tracking cookies. We only keep a few small items in your browser so you stay signed in and the app remembers your preferences.
                </p>

                <h3 className="text-lg font-medium">2. What we keep in your browser</h3>
                <p>The app uses your browser's local storage (and one small cookie) for:</p>
                <ul className="list-disc pl-6 space-y-2">
                  <li><strong>Signing in:</strong> your sign-in session and basic account details (Pi username, account ID, wallet address and plan), so you don't have to sign in on every visit.</li>
                  <li><strong>Preferences:</strong> light or dark theme, whether the side menu is open (the one cookie), the analytics date range, and the CommuniCon tab you last used.</li>
                  <li><strong>Things you've done in the app:</strong> your saved businesses, your recent CommuniCon AI chat, and whether you've already seen tips such as the location banner.</li>
                  <li><strong>Map data:</strong> names and outlines of map areas you've tapped, kept for up to 7 days so they open faster.</li>
                  <li><strong>Payments in progress:</strong> an unfinished Pi payment, only until the browser tab is closed.</li>
                </ul>
                <p>
                  Your own location is never saved in your browser: the position used to centre the map and your GPS location stay in memory for that visit only. If you set a home location, it is saved to your account, not to your browser.
                </p>

                <h3 className="text-lg font-medium">3. What we don't use</h3>
                <ul className="list-disc pl-6 space-y-2">
                  <li>No advertising cookies. The app has no ads.</li>
                  <li>No third-party analytics or tracking cookies, and no tracking pixels.</li>
                  <li>No social media cookies.</li>
                </ul>

                <h3 className="text-lg font-medium">4. How to clear it</h3>
                <p>
                  Signing out clears your sign-in session. You can clear everything else by clearing this site's data in your browser settings. You'll need to sign in again afterwards, and your preferences go back to the defaults.
                </p>

                <h3 className="text-lg font-medium">5. More information</h3>
                <p>
                  Our <Link to="/privacy" className="text-primary hover:underline">Privacy Policy</Link> explains what information we collect and who processes it. When we change this Cookie Policy, we'll update the date at the top.
                </p>
                <p>
                  Questions? Email us at <strong>support@avantemaps.com</strong>.
                </p>
                <p>
                  <strong>Address:</strong> Pietermaritzburg, South Africa
                </p>
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
};

export default CookiePolicy;
