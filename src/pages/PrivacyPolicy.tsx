import React from 'react';
import AppLayout from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

const PrivacyPolicy = () => {
  return (
    <AppLayout title="Privacy Policy">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 pb-10">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-bold">Privacy Policy</CardTitle>
          </CardHeader>

          {/* ScrollArea wraps the CardContent */}
          <ScrollArea className="h-[60vh]">
            <CardContent className="prose prose-slate max-w-none py-[20px] pr-4">
              <p className="text-muted-foreground"><strong>Effective Date:</strong> November 13, 2026</p>

              <div className="space-y-8">
                <section>
                  <h2 className="text-xl font-bold mb-4">1. Who we are</h2>
                  <p>
                    Avante Maps is a directory of businesses that accept Pi. It is run by Avante Maps Pty Ltd ("we", "us"). It is an independent app for Pi users: it is not made by, run by or affiliated with Pi Network.
                  </p>
                  <p className="mt-2">
                    This policy explains, in plain language, what we collect, why, who helps us process it, and how to ask us to see or delete it.
                  </p>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">2. What we collect from you</h2>
                  <ul className="list-disc pl-6 space-y-2">
                    <li><strong>Your Pi account:</strong> your Pi username, Pi user ID and Pi wallet address, which Pi sends us when you sign in with Pi. We don't ask for your name, email address or phone number.</li>
                    <li><strong>Home location:</strong> only if you set one. It is saved to your account so the map can open there, and you can remove it in Settings.</li>
                    <li><strong>Approximate location:</strong> to centre the map near you, the app asks an IP geolocation service for a rough position based on your IP address. If you tap Locate me and allow it, your browser's location is used. Neither is saved to your account.</li>
                    <li><strong>Messages and reviews:</strong> messages you send to businesses, and the reviews and comments you post.</li>
                    <li><strong>CommuniCon AI chat:</strong> the text you type to the AI assistant, so it can reply.</li>
                    <li><strong>Searches and business page views:</strong> what you search for and which business pages you open, used for the business owners' analytics.</li>
                    <li><strong>Payments:</strong> the plan, the amount in π, and the Pi payment's ID and status, so we can activate your plan and show your wallet activity.</li>
                    <li><strong>Error logs and device info:</strong> error reports and your browser's user agent, so we can find and fix problems.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">3. What businesses provide</h2>
                  <p>If you list a business, you give us:</p>
                  <ul className="list-disc pl-6 space-y-2 mt-2">
                    <li>The business name, address and map position, photos, opening hours and description.</li>
                    <li>Contact details: phone, email, website and contact names. <strong>These are shown publicly on your listing.</strong></li>
                    <li>A payout wallet address for receiving Pi.</li>
                    <li>Optionally, a verified email address for new-message alerts and account notices. You can turn alerts off at any time.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">4. How we use it</h2>
                  <ul className="list-disc pl-6 space-y-2">
                    <li>To sign you in, show the map and listings, and deliver messages.</li>
                    <li>To activate plans you pay for and keep a record of payments.</li>
                    <li>To show business owners how people find their listings (searches and page views).</li>
                    <li>To send business owners the emails they asked for: contact verification codes, new-message alerts, plan reminders and important account notices.</li>
                    <li>To keep the app working and secure, and to fix errors.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">5. Who processes it for us</h2>
                  <p>We use these service providers to run the app. Each one only gets what it needs for its job:</p>
                  <ul className="list-disc pl-6 space-y-2 mt-2">
                    <li><strong>Supabase:</strong> our database, file storage and sign-in sessions.</li>
                    <li><strong>Vercel:</strong> hosts the app.</li>
                    <li><strong>Brevo:</strong> sends our emails (contact verification codes, new-message alerts, plan reminders and account notices) to business owners' verified addresses.</li>
                    <li><strong>Lovable AI gateway:</strong> generates the CommuniCon AI replies from the chat text you send.</li>
                    <li><strong>IP geolocation services:</strong> ipwho.is (to centre the map and pick your country), and ipapi.co and geojs.io (Locate me, when your device can't give a location). They see your IP address.</li>
                    <li><strong>OpenStreetMap:</strong> map tiles, and place names when you tap an area on the map. The map library's files load from unpkg.com.</li>
                  </ul>
                  <p className="mt-2">
                    Pi Network handles signing in with Pi and Pi payments under Pi Network's own terms and privacy policy. We receive only the account and payment details listed above.
                  </p>
                  <p className="mt-2">
                    We may also share information if the law requires it, or to protect people's safety.
                  </p>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">6. What we don't do</h2>
                  <ul className="list-disc pl-6 space-y-2">
                    <li>We don't sell your data.</li>
                    <li>We don't show ads.</li>
                    <li>We don't use advertising trackers or cookies.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">7. How long we keep it</h2>
                  <p>
                    We keep your information while your account is active. If you delete your account in Settings, it is deleted for good after 15 days, and you can change your mind before then. Error logs are kept only as long as we need them to fix problems.
                  </p>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">8. Seeing, correcting or deleting your data</h2>
                  <ul className="list-disc pl-6 space-y-2">
                    <li>To get a copy of your data, correct it or have it deleted, email <strong>support@avantemaps.com</strong> from the app's Contact page and tell us your Pi username.</li>
                    <li>You can delete your account yourself in Settings.</li>
                    <li>You can remove your home location in Settings, and edit or remove your business listings at any time.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">9. Children</h2>
                  <p>
                    Avante Maps is not meant for children under 13, and we don't knowingly collect their data. If you think a child has given us information, contact us and we'll delete it.
                  </p>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">10. Changes to this policy</h2>
                  <p>
                    When we change this policy, we'll update it here and change the effective date at the top.
                  </p>
                </section>

                <section>
                  <h2 className="text-xl font-bold mb-4">11. Contact us</h2>
                  <p>
                    Questions about this policy or your data? Contact Avante Maps Pty Ltd:
                  </p>
                  <p className="mt-2">
                    <strong>Email:</strong> support@avantemaps.com<br />
                    <strong>Address:</strong> Pietermaritzburg, South Africa
                  </p>
                </section>
              </div>
            </CardContent>
          </ScrollArea>
        </Card>
      </div>
    </AppLayout>
  );
};

export default PrivacyPolicy;
