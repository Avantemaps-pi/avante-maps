import React from 'react';
import { Link } from '@/lib/router-compat';
import { Mail, LifeBuoy } from 'lucide-react';
import AvanteMark from '@/components/brand/AvanteMark';

const Logo: React.FC = () => (
  <div className="flex items-center gap-2">
    <AvanteMark className="h-9 w-9 text-white dark:text-primary" />
    <span className="font-bold text-lg text-white dark:text-foreground">Avante Maps</span>
  </div>
);

const Footer: React.FC = () => {
  return (
    <footer className="w-full bg-brand-navy text-white dark:bg-card dark:text-foreground dark:border-t dark:border-border">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8 text-center sm:text-left">
          {/* Column 1: Logo + Tagline */}
          <div className="flex flex-col items-center sm:items-start">
            <Logo />
            <p className="mt-3 text-white/70 dark:text-muted-foreground text-sm">Discover. Connect. Transact.</p>
          </div>

          {/* Column 2: Company Links */}
          <div>
            <h4 className="font-semibold mb-3 text-sm uppercase tracking-wide text-white/90 dark:text-foreground">
              Company
            </h4>
            <ul className="space-y-2 text-sm text-white/70 dark:text-muted-foreground">
              <li>
                <Link to="/pricing" className="hover:text-white dark:hover:text-foreground transition-colors">
                  Pricing
                </Link>
              </li>
              <li>
                <Link to="/privacy" className="hover:text-white dark:hover:text-foreground transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link to="/terms" className="hover:text-white dark:hover:text-foreground transition-colors">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link to="/cookies" className="hover:text-white dark:hover:text-foreground transition-colors">
                  Cookie Policy
                </Link>
              </li>
            </ul>
          </div>

          {/* Column 3: Support */}
          <div>
            <h4 className="font-semibold mb-3 text-sm uppercase tracking-wide text-white/90 dark:text-foreground">
              Support
            </h4>
            <ul className="space-y-2 text-sm text-white/70 dark:text-muted-foreground">
              <li>
                <Link
                  to="/contact"
                  className="hover:text-white dark:hover:text-foreground inline-flex items-center gap-2 transition-colors"
                >
                  <Mail className="h-4 w-4" /> Contact Us
                </Link>
              </li>
              <li>
                <Link
                  to="/contact"
                  className="hover:text-white dark:hover:text-foreground inline-flex items-center gap-2 transition-colors"
                >
                  <LifeBuoy className="h-4 w-4" /> Help & Support
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-8 sm:mt-10 pt-6 border-t border-white/10 dark:border-border text-center text-xs text-white/60 dark:text-muted-foreground">
          © {new Date().getFullYear()} Avante Maps Pty Ltd. An independent app for Pi users.
        </div>
      </div>
    </footer>
  );
};

export default Footer;
