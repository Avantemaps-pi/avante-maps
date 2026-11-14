import React, { useState } from 'react';
import { MapPin, Bookmark, MessageCircle, Star, Mail, LifeBuoy, BarChart3 } from 'lucide-react';
import { Link } from '@/lib/router-compat';
import { Button } from '@/components/ui/button';
import AvanteMark from '@/components/brand/AvanteMark';
import LoginDialog from '@/components/auth/LoginDialog';

const features = [
  { icon: MapPin, title: 'Interactive Map', desc: "See exactly where Pi-accepting businesses are, filtered by what you're looking for." },
  { icon: Bookmark, title: 'Save Favourites', desc: 'Save the ones you love. Come back to them whenever you need them.' },
  { icon: MessageCircle, title: 'Message Directly', desc: 'Message a business directly — no middleman, no waiting on hold.' },
  { icon: Star, title: 'Trusted Reviews', desc: 'Leave honest reviews. Help the next person in the Pi community make a good call.' },
];

const differentiators = [
  {
    icon: MessageCircle,
    title: 'Direct messaging',
    desc: 'Talk to a business before you visit. No app-switching, no waiting.',
  },
  {
    icon: BarChart3,
    title: 'Business analytics',
    desc: "Business owners see who's finding them and how — real data, not guesswork.",
  },
];

const LandingPage: React.FC = () => {
  const [showLogin, setShowLogin] = useState(true);

  const scrollToFeatures = () => {
    document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
  };

  const Logo = ({ light = false }: { light?: boolean }) => (
    <div className="flex items-center gap-2.5">
      {light ? (
        <div className="h-10 w-10 rounded-full bg-white/10 dark:bg-accent flex items-center justify-center">
          <AvanteMark weight="bold" className="h-7 w-7 text-white dark:text-primary" />
        </div>
      ) : (
        <AvanteMark className="h-9 w-9 text-primary" />
      )}
      <span className={`font-semibold text-lg tracking-tight ${light ? 'text-white dark:text-foreground' : 'text-brand-navy'}`}>
        Avante Maps
      </span>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Sticky Nav */}
      <header className="sticky top-0 z-40 bg-background/90 backdrop-blur-sm border-b border-border/60">
        <div className="max-w-5xl mx-auto px-5 sm:px-6 h-16 flex items-center justify-between">
          <Logo />
          <Button
            variant="ghost"
            onClick={() => setShowLogin(true)}
            className="text-brand-navy hover:text-brand-navy hover:bg-primary/10"
          >
            Sign In
          </Button>
        </div>
      </header>

      {/* HERO */}
      <section className="relative overflow-hidden bg-brand-navy text-white dark:bg-card dark:text-foreground dark:border-b dark:border-border">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            color: 'currentColor',
          }}
        />
        <div className="relative max-w-5xl mx-auto px-5 sm:px-6 py-20 sm:py-28 md:py-36">
          <div className="flex flex-col md:flex-row items-center gap-12 md:gap-16">
            <div className="flex-1 max-w-2xl text-center md:text-left mx-auto md:mx-0">
              <h1 className="font-semibold text-white dark:text-foreground tracking-tight text-[34px] leading-[1.1] sm:text-5xl md:text-[56px] md:leading-[1.05]">
                A Business Directory Built By One Person, For The Pi Community
              </h1>
              <p className="mt-6 text-white/75 dark:text-muted-foreground leading-relaxed text-base sm:text-lg max-w-xl mx-auto md:mx-0">
                I'm building the map I wish existed when I started using Pi — a real place to find, message, and support businesses that accept it. No corporate backing. Just one developer and a community that showed up.
              </p>
              <div className="mt-10 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-center md:justify-start max-w-xs sm:max-w-none mx-auto md:mx-0">
                <Button
                  onClick={() => setShowLogin(true)}
                  size="lg"
                  className="w-full sm:w-auto font-medium bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  Get Started with Pi
                </Button>
                <Button
                  onClick={scrollToFeatures}
                  variant="ghost"
                  size="lg"
                  className="w-full sm:w-auto text-white/90 hover:bg-white/10 hover:text-white dark:text-foreground dark:hover:bg-accent dark:hover:text-accent-foreground"
                >
                  Learn More
                </Button>
              </div>
            </div>
            {/* A simple map illustration: the Avante mark among a few pins, blue and white only */}
            <div className="hidden md:block flex-1" aria-hidden>
              <div className="relative aspect-[4/3] w-full rounded-2xl border border-white/15 bg-white/5 dark:border-border dark:bg-accent/40">
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-32 w-32 rounded-full bg-white dark:bg-background flex items-center justify-center shadow-2xl">
                    <AvanteMark weight="bold" className="h-20 w-20 text-primary" />
                  </div>
                </div>
                <MapPin className="absolute left-[16%] top-[20%] h-9 w-9 text-white/80 dark:text-primary" strokeWidth={1.75} />
                <MapPin className="absolute right-[18%] top-[28%] h-7 w-7 text-white/60 dark:text-primary/80" strokeWidth={1.75} />
                <MapPin className="absolute left-[26%] bottom-[16%] h-7 w-7 text-white/60 dark:text-primary/80" strokeWidth={1.75} />
                <MapPin className="absolute right-[24%] bottom-[22%] h-9 w-9 text-white/80 dark:text-primary" strokeWidth={1.75} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="py-24 sm:py-32 px-5 sm:px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="font-semibold tracking-tight text-brand-navy text-2xl sm:text-3xl md:text-4xl max-w-2xl">
            What Avante Maps does today
          </h2>
          <div className="mt-12 sm:mt-16 grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-10">
            {features.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="max-w-sm">
                <Icon className="h-6 w-6 text-primary" strokeWidth={1.75} />
                <h3 className="mt-4 font-semibold text-lg tracking-tight text-brand-navy">{title}</h3>
                <p className="mt-2 text-[15px] text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* BUILT FOR MORE THAN JUST DISCOVERY */}
      <section className="py-24 sm:py-32 px-5 sm:px-6 bg-primary/5">
        <div className="max-w-4xl mx-auto">
          <h2 className="font-semibold tracking-tight text-brand-navy text-2xl sm:text-3xl md:text-4xl max-w-2xl">
            Built for more than just discovery
          </h2>
          <div className="mt-12 sm:mt-16 grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-10">
            {differentiators.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="max-w-sm">
                <Icon className="h-6 w-6 text-primary" strokeWidth={1.75} />
                <h3 className="mt-4 font-semibold text-lg tracking-tight text-brand-navy">{title}</h3>
                <p className="mt-2 text-[15px] text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PI CALLOUT */}
      <section className="py-24 sm:py-32 px-5 sm:px-6">
        <div className="max-w-2xl mx-auto text-center">
          <AvanteMark className="mx-auto mb-7 h-14 w-14 text-primary" />
          <h2 className="font-semibold tracking-tight text-brand-navy text-2xl sm:text-3xl md:text-4xl">
            Made For Pi. Not Made By Pi.
          </h2>
          <p className="mt-5 text-muted-foreground leading-relaxed text-base sm:text-lg">
            Avante Maps isn't an official Pi Network product — it's an independent app built by a KYC-verified Pi Network member, for the community I'm part of. Every business registration, message, and review here runs on Pi. And this is just the beginning of what I'm building toward.
          </p>
          <div className="mt-9 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-center max-w-xs sm:max-w-none mx-auto">
            <Button asChild variant="outline" className="w-full sm:w-auto font-medium border-border text-brand-navy hover:bg-primary/10">
              <Link to="/pricing">View pricing</Link>
            </Button>
            <Button asChild variant="outline" className="w-full sm:w-auto font-medium border-border text-brand-navy hover:bg-primary/10">
              <Link to="/about">Learn about us</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* FOUNDER NOTE */}
      <section className="pb-24 sm:pb-32 px-5 sm:px-6">
        <div className="max-w-3xl mx-auto border-l-2 border-primary/40 pl-6 sm:pl-8">
          <p className="text-muted-foreground leading-relaxed text-base sm:text-lg">
            👋 Hi, I'm the person building this. There are already ways to find Pi businesses on a map — but none of them let you message a business directly, or give business owners real analytics on who's finding them. So I built Avante Maps to close that gap. It's early, it's solo, and it's growing. Thank you for being here at the start. — Founder, Avante Maps
          </p>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="mt-auto py-16 px-5 sm:px-6 bg-brand-navy text-white dark:bg-card dark:text-foreground dark:border-t dark:border-border">
        <div className="max-w-5xl mx-auto grid grid-cols-2 sm:grid-cols-3 gap-10 text-center sm:text-left">
          <div className="col-span-2 sm:col-span-1 flex flex-col items-center sm:items-start">
            <Logo light />
            <p className="mt-4 text-white/70 dark:text-muted-foreground text-sm leading-relaxed max-w-xs">
              Discover. Connect. Transact. — Built solo, one commit at a time.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-4 text-xs uppercase tracking-widest text-white/60 dark:text-muted-foreground">Company</h4>
            <ul className="space-y-2.5 text-sm text-white/75 dark:text-muted-foreground">
              <li><Link to="/pricing" className="hover:text-white dark:hover:text-foreground">Pricing</Link></li>
              <li><Link to="/privacy" className="hover:text-white dark:hover:text-foreground">Privacy Policy</Link></li>
              <li><Link to="/terms" className="hover:text-white dark:hover:text-foreground">Terms of Service</Link></li>
              <li><Link to="/cookies" className="hover:text-white dark:hover:text-foreground">Cookie Policy</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-medium mb-4 text-xs uppercase tracking-widest text-white/60 dark:text-muted-foreground">Support</h4>
            <ul className="space-y-2.5 text-sm text-white/75 dark:text-muted-foreground">
              <li>
                <Link to="/contact" className="hover:text-white dark:hover:text-foreground inline-flex items-center gap-2">
                  <Mail className="h-4 w-4" /> Contact Us
                </Link>
              </li>
              <li>
                <Link to="/contact" className="hover:text-white dark:hover:text-foreground inline-flex items-center gap-2">
                  <LifeBuoy className="h-4 w-4" /> Help & Support
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="max-w-5xl mx-auto mt-12 pt-6 border-t border-white/15 dark:border-border text-center text-xs text-white/60 dark:text-muted-foreground">
          © {new Date().getFullYear()} Avante Maps Pty Ltd. An independent app for Pi users.
        </div>
      </footer>

      <LoginDialog
        open={showLogin}
        onOpenChange={setShowLogin}
        continueBrowsingLabel="Learn more"
        onContinueBrowsing={scrollToFeatures}
      />
    </div>
  );
};

export default LandingPage;
