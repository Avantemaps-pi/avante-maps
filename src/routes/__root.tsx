import React, { Suspense, useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
} from "@tanstack/react-router";
import { HelmetProvider } from "react-helmet-async";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AuthProvider } from "@/context/auth";
import { useSessionRestoration } from "@/hooks/useSessionRestoration";
import { SessionManager } from "@/components/session/SessionManager";
import { PendingConversationDispatcher } from "@/components/session/PendingConversationDispatcher";
import AuthenticatingOverlay from "@/components/auth/AuthenticatingOverlay";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import NotFound from "@/pages/NotFound";
import { initializePiNetwork } from "@/utils/piNetwork";
import { prefetchHighPriorityRoutes } from "@/lib/routePrefetch";
import { markAppHydrated } from "@/utils/hydrationSignal";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { MAINNET_PI_HOSTNAMES } from "@/config/environment";

import appCss from "../styles.css?url";
import heroIcon72 from "@/assets/avante-icon-72.webp";
import heroIcon144 from "@/assets/avante-icon-144.webp";

// Preserved verbatim from the Classic index.html — Pi SDK is initialized exactly
// ONCE here; sandbox is FALSE only on the exact mainnet hostnames below.
//
// Hostname list is interpolated at build time from MAINNET_PI_HOSTNAMES
// (src/config/environment.ts) — the single source of truth also used by
// src/utils/piNetwork/core.ts's determineSandboxMode() fallback. This script itself
// stays a raw inline string (it must run before the JS bundle loads, so it can't
// import that constant at runtime) — do not hardcode a second hostname list here.
const PI_INIT_SCRIPT = `
      // Wrapped in an IIFE so nothing is declared at the top level: the router can
      // re-insert head scripts on client-side navigation, and a second top-level
      // "const hostname" would throw. The flag keeps Pi.init() to once per page load.
      (function () {
        if (window.__piInitScriptRan) return;
        window.__piInitScriptRan = true;

        // Sandbox detection: ONLY the exact mainnet hostnames below use sandbox: false.
        // Every other hostname (localhost, preview, testnet.avantemaps.com, etc.) uses
        // sandbox: true. Exact-match only — a suffix/endsWith check previously and
        // incorrectly classified testnet.avantemaps.com as mainnet.
        const hostname = window.location.hostname;
        const isMainnetHost = ${JSON.stringify(MAINNET_PI_HOSTNAMES)}.includes(hostname);
        const isSandbox = !isMainnetHost;

        // Initialize Pi SDK immediately when script loads (not on window.load)
        // This ensures Pi.init() is called before any authenticate() calls
        // IMPORTANT: This is the ONLY place Pi.init() should be called
        (function initPiSdk() {
          if (window.Pi) {
            console.log("🔧 Pi SDK Init:", { hostname, isMainnetHost, sandbox: isSandbox });
            Pi.init({
              version: "2.0",
              sandbox: isSandbox,
            });
            window.__piInitialized = true;
            window.__piSandboxMode = isSandbox;
          } else {
            // Retry after a short delay if SDK isn't ready yet
            setTimeout(initPiSdk, 50);
          }
        })();
      })();
`;

const CSP_CONTENT = `
      default-src 'self' https: blob: data:;
      script-src 'self' https://sdk.minepi.com https://unpkg.com https://cdn.gpteng.co 'unsafe-inline' 'unsafe-eval';
      style-src 'self' 'unsafe-inline' https:;
      img-src 'self' https: data: blob:;
      font-src 'self' https: data:;
      connect-src 'self' https://api.minepi.com https://socialchain.app https:;
      frame-src https:;
      object-src 'none';
      base-uri 'self';
      form-action 'self';
      upgrade-insecure-requests;
    `;

const ORG_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Avante Maps",
  url: "https://mainnet.avantemaps.com",
  logo: "https://mainnet.avantemaps.com/lovable-uploads/Avante-Maps-icon.svg",
  description: "Discover local and online businesses that accept Pi Network cryptocurrency.",
  sameAs: ["https://twitter.com/AvanteMap"],
});

const WEBSITE_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Avante Maps",
  url: "https://mainnet.avantemaps.com",
  potentialAction: {
    "@type": "SearchAction",
    target: "https://mainnet.avantemaps.com/recommendations?search={search_term_string}",
    "query-input": "required name=search_term_string",
  },
});

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "UTF-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      // SECURITY: Pi-Compatible Content Security Policy
      { httpEquiv: "Content-Security-Policy", content: CSP_CONTENT },
      { title: "Avante Maps - Discover Local Businesses with Pi Network" },
      // Primary Meta Tags
      { name: "title", content: "Avante Maps - Local Business Discovery" },
      {
        name: "description",
        content:
          "Find and explore local businesses on Avante Maps. Register your business, get discovered by customers, and transact with Pi cryptocurrency.",
      },
      {
        name: "keywords",
        content:
          "pi network, local businesses, business directory, cryptocurrency, pi payment, avante maps",
      },
      { name: "author", content: "Avante Maps Team" },
      // Open Graph / Facebook
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://mainnet.avantemaps.com/" },
      { property: "og:title", content: "Avante Maps - Discover Local Businesses" },
      {
        property: "og:description",
        content:
          "Find local businesses and pay with Pi Network cryptocurrency. Join the Pi business community.",
      },
      { property: "og:image", content: "https://mainnet.avantemaps.com/og-image.png" },
      { property: "og:image:secure_url", content: "https://mainnet.avantemaps.com/og-image.png" },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Avante Maps - Local Business Directory" },
      { property: "og:site_name", content: "Avante Maps" },
      { property: "og:locale", content: "en_US" },
      // Twitter Card
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: "@AvanteMap" },
      { name: "twitter:creator", content: "@AvanteMap" },
      { name: "twitter:title", content: "Avante Maps - Discover Local Businesses" },
      {
        name: "twitter:description",
        content: "Find local businesses and pay with Pi Network cryptocurrency",
      },
      { name: "twitter:image", content: "https://mainnet.avantemaps.com/og-image.png" },
      { name: "twitter:image:alt", content: "Avante Maps Preview" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Preconnect to external origins for faster loading
      { rel: "preconnect", href: "https://sdk.minepi.com", crossOrigin: "anonymous" },
      { rel: "preconnect", href: "https://unpkg.com", crossOrigin: "anonymous" },
      { rel: "preconnect", href: "https://tile.openstreetmap.org", crossOrigin: "anonymous" },
      // Preload hero logo (LCP candidate on landing page)
      {
        rel: "preload",
        as: "image",
        href: heroIcon72,
        imageSrcSet: `${heroIcon72} 72w, ${heroIcon144} 144w`,
        imageSizes: "36px",
        fetchPriority: "high",
      },
      // Leaflet CSS (also bundled via npm imports; kept for parity with Classic index.html)
      { rel: "stylesheet", href: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" },
    ],
    scripts: [
      // Load Pi SDK
      { src: "https://sdk.minepi.com/pi-sdk.js" },
      { children: PI_INIT_SCRIPT },
      { type: "application/ld+json", children: ORG_JSON_LD },
      { type: "application/ld+json", children: WEBSITE_JSON_LD },
      // IMPORTANT: DO NOT REMOVE THIS TAG
      { src: "https://cdn.gpteng.co/gptengineer.js", type: "module", defer: true },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: () => <NotFound />,
  errorComponent: RootErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

const PageLoader = () => (
  <div className="flex flex-col min-h-screen bg-background">
    {/* Header skeleton */}
    <div className="h-14 border-b border-border px-4 flex items-center gap-3">
      <div className="h-8 w-8 rounded-md bg-muted animate-pulse" />
      <div className="h-4 w-32 rounded bg-muted animate-pulse" />
    </div>
    {/* Content skeleton */}
    <div className="flex-1 p-4 space-y-4">
      <div className="h-5 w-48 rounded bg-muted animate-pulse" />
      <div className="space-y-3">
        <div className="h-40 w-full rounded-lg bg-muted animate-pulse" />
        <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
        <div className="h-4 w-1/2 rounded bg-muted animate-pulse" />
      </div>
      <div className="space-y-3 pt-2">
        <div className="h-40 w-full rounded-lg bg-muted animate-pulse" />
        <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
        <div className="h-4 w-1/3 rounded bg-muted animate-pulse" />
      </div>
    </div>
  </div>
);

/**
 * SessionRestoration handles visibility/network changes.
 * SessionManager handles centralized Supabase auth error detection.
 */
const SessionRestoration = () => {
  useSessionRestoration();
  return null;
};

/**
 * Rendered INSIDE the root Suspense boundary so its mount effect fires only
 * after the route subtree has hydrated. Signals AuthProvider that it is now
 * safe to restore the cached session without causing hydration mismatches.
 */
const AppHydrationSignal = () => {
  useEffect(() => {
    markAppHydrated();
  }, []);
  return null;
};

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // ported from App.tsx — Pi SDK loader fallback (init itself lives in head() script)
  useEffect(() => {
    const initPiSdk = async () => {
      if (typeof window === "undefined") return;
      if (window.Pi) {
        console.log("✅ Pi SDK already loaded.");
        return;
      }

      try {
        console.log("📦 Loading Pi SDK...");
        await initializePiNetwork();
        console.log("✅ Pi SDK initialized successfully");
      } catch (err) {
        console.error("❌ Failed to initialize Pi SDK:", err);
      }
    };

    // Wait until DOM is ready
    if (document.readyState === "complete") {
      initPiSdk();
    } else {
      window.addEventListener("load", initPiSdk);
      return () => window.removeEventListener("load", initPiSdk);
    }
    return undefined;
  }, []);

  // ported from App.tsx — color scheme bootstrap
  useEffect(() => {
    const savedScheme = localStorage.getItem("colorScheme");
    if (savedScheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("colorScheme", "light");
    }
  }, []);

  // Warm the route cache for likely-next pages during idle time so
  // the first navigation away from the landing/map page feels instant.
  useEffect(() => {
    prefetchHighPriorityRoutes();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <HelmetProvider>
        <TooltipProvider>
          <ErrorBoundary>
            <AuthProvider>
              <AuthenticatingOverlay />
              <SidebarProvider>
                <SessionRestoration />
                <SessionManager />
                <PendingConversationDispatcher />
                <Toaster />
                <Sonner />
                <Suspense fallback={<PageLoader />}>
                  <AppHydrationSignal />
                  <Outlet />
                </Suspense>
              </SidebarProvider>
            </AuthProvider>
          </ErrorBoundary>
        </TooltipProvider>
      </HelmetProvider>
    </QueryClientProvider>
  );
}

function RootErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();

  useEffect(() => {
    console.error(error);
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground mb-2">This page didn't load</h1>
        <p className="text-muted-foreground mb-6">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
