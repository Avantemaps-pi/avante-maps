import React from 'react';
import AvanteMark from '@/components/brand/AvanteMark';
import AppLayout from '@/components/layout/AppLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Mail, MessageCircle, Facebook, Twitter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from '@/lib/router-compat';
import MetaTags from '@/components/seo/MetaTags';

const About = () => {
  const navigate = useNavigate();

  return (
    <AppLayout title="About Us">
      <MetaTags
        title="About Avante Maps"
        description="Learn about Avante Maps — an independent platform mapping businesses that accept Pi Network cryptocurrency, built to grow the Pi ecosystem."
        keywords={['about avante maps', 'pi network', 'pi cryptocurrency', 'pi ecosystem']}
        ogType="website"
      />
      <div className="max-w-5xl mx-auto space-y-6 px-4 sm:px-6 pt-3 sm:pt-4 pb-6 animate-fade-in" role="region" aria-labelledby="page-title">
        <Card className="material-card">
          <CardHeader>
           <CardTitle className="text-xl font-semibold flex items-center gap-2">
               <AvanteMark className="h-10 w-10 text-primary" />
              Our Mission
            </CardTitle>
            <CardDescription>
              Empowering businesses and consumers with cryptocurrency
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>
              Avante Maps is dedicated to accelerating the adoption of Pi cryptocurrency by connecting consumers with local and online businesses that accept Pi as payment.
            </p>
            <p>
              Our platform makes it easy for Pi holders to discover places where they can spend their digital currency, while helping businesses reach a growing community of crypto enthusiasts.
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="material-card">
            <CardHeader>
              <CardTitle className="text-xl font-semibold">For Businesses</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p>
                By registering your business on Avante Maps, you gain access to a dedicated community of Pi users looking to support businesses that embrace cryptocurrency.
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>Increased visibility in the Pi ecosystem</li>
                <li>Simplified customer discovery process</li>
                <li>Free business listing and promotion</li>
                <li>Join the future of digital payments</li>
              </ul>
              <Button className="w-full mt-4" variant="outline" onClick={() => navigate('/registration')}>
                Register Your Business
              </Button>
            </CardContent>
          </Card>

          <Card className="material-card">
            <CardHeader>
              <CardTitle className="text-xl font-semibold">For Consumers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p>
                Find places to spend your Pi cryptocurrency, from local cafes to online shops, all in one convenient location.
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>Discover Pi-accepting businesses near you</li>
                <li>Save your favorite places for later</li>
                <li>Get notifications about new businesses</li>
                <li>Support the growing Pi economy</li>
              </ul>
              <Button className="w-full mt-4" onClick={() => navigate('/')}>
                Explore the Map
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card className="material-card">
          <CardHeader>
            <CardTitle className="text-xl font-semibold">Our Story</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>
              Avante Maps was founded by a Solo Aspiring Developer who recognized the need for a dedicated platform to connect Pi users with businesses accepting the currency.
            </p>
            <p>
              We're starting as a simple directory with the intent of evolving into a comprehensive social experience platform, designed to make Pi cryptocurrency more accessible and useful in everyday transactions.
            </p>
            <p>
              We're constantly working to improve our platform and expand our database of Pi-accepting businesses worldwide.
            </p>
          </CardContent>
        </Card>

        <Card className="material-card">
          <CardHeader>
            <CardTitle className="text-xl font-semibold">Map data</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              Maps use data from OpenStreetMap, ©{' '}
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                OpenStreetMap contributors
              </a>
              , available under the Open Database License.
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col items-center justify-center space-y-4 py-8">
          <h2 className="text-2xl font-semibold">Connect With Us</h2>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="rounded-full hover:text-primary" asChild>
              <a href="https://wa.me/27683422444" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp">
                <MessageCircle className="h-5 w-5" />
              </a>
            </Button>
            <Button variant="outline" size="icon" className="rounded-full hover:text-primary" asChild>
              <a href="https://x.com/Avantemaps" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)">
                <Twitter className="h-5 w-5" />
              </a>
            </Button>
            <Button variant="outline" size="icon" className="rounded-full hover:text-primary" asChild>
              <a href="https://web.facebook.com/profile.php?id=61570803414310" target="_blank" rel="noopener noreferrer" aria-label="Facebook">
                <Facebook className="h-5 w-5" />
              </a>
            </Button>
            <Button variant="outline" className="rounded-full" size="icon" asChild>
              <a href="mailto:inquiries@avantemaps.com" aria-label="Email">
                <Mail className="h-5 w-5" />
              </a>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-4">
            © 2026 Avante Maps. All rights reserved.
          </p>
        </div>
      </div>
    </AppLayout>
  );
};

export default About;
