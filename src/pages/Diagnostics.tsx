import React, { useCallback, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { toast } from 'sonner';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth';
import NotFound from '@/pages/NotFound';
import {
  ensurePiPaymentsAuth,
  getLastIncompletePayment,
  getNativeFeaturesList,
  hasPaymentsAuth,
  isPiBrowser,
  isPiInstanceInitialized,
  withPiInit,
} from '@/utils/piNetwork';

// What this page uses of the Pi SDK. window.Pi is typed any in global.d.ts
interface PiDiagnosticsApi {
  nativeFeaturesList?: () => Promise<unknown>;
  requestPermission?: (permission: string) => Promise<unknown>;
  copyText?: (text: string) => unknown;
}

interface Row {
  label: string;
  value: string;
}

const NOT_AVAILABLE = 'not available';

const getPi = (): PiDiagnosticsApi | null =>
  window.Pi ? (window.Pi as PiDiagnosticsApi) : null;

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms),
    ),
  ]);

const describe = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
const errorText = (error: unknown) =>
  `error: ${error instanceof Error ? error.message : String(error)}`;

// The Pi SDK's state, read when the page opens (before any check here calls the SDK). The
// per-instance marker is set on window.Pi itself when we call Pi.init() on that object, so a
// replaced window.Pi (a reloaded pi-sdk.js) reads "no" even while the page flags say initialised
interface PiSdkWindow {
  Pi?: { __avanteInit?: boolean; nativeFeaturesList?: () => Promise<unknown> };
  __piSandboxMode?: boolean;
  __piInitialized?: boolean;
  __piInitializedInstance?: unknown;
}

const flag = (value: unknown) =>
  typeof value === 'boolean' ? String(value) : 'not set';

function readPiSdk(): Row[] {
  const w = window as unknown as PiSdkWindow;
  const instanceInitialised = w.Pi
    ? isPiInstanceInitialized(w.Pi)
      ? 'yes'
      : 'no'
    : 'no window.Pi';
  return [
    { label: 'Pi SDK: Pi Browser (user agent)', value: isPiBrowser() ? 'yes' : 'no' },
    { label: 'Pi SDK: hostname', value: window.location.hostname },
    { label: 'Pi SDK: sandbox used by init', value: flag(w.__piSandboxMode) },
    { label: 'Pi SDK: window.__piInitialized', value: flag(w.__piInitialized) },
    { label: 'Pi SDK: this window.Pi initialised by us', value: instanceInitialised },
    {
      label: 'Pi SDK: this window.Pi authenticated with payments',
      value: w.Pi ? (hasPaymentsAuth(w.Pi) ? 'yes' : 'no') : 'no window.Pi',
    },
    incompletePaymentRow(),
    scriptTagsRow(),
  ];
}

// What Pi last reported as unfinished on this page (when Pi.authenticate or createPayment ran)
const incompletePaymentRow = (): Row => {
  const seen = getLastIncompletePayment();
  return {
    label: 'Pi SDK: unfinished payment reported by Pi',
    value: seen
      ? `${seen.paymentId} (${seen.hasTxid ? 'has a transaction' : 'no transaction'}; ${seen.outcome})`
      : 'none reported',
  };
};

// Kept current while the page is open. The server's HTML has one, and the SDK runs while the page
// loads; hydration can then take the head's script tags out, so 0 is normal after that. 2 or more
// would mean a second pi-sdk.js was added (which replaces window.Pi)
const scriptTagsRow = (): Row => ({
  label: 'Pi SDK: pi-sdk.js script tags now',
  value: String(document.querySelectorAll('script[src*="sdk.minepi.com/pi-sdk.js"]').length),
});

// Checks that don't need a tap. Each one is guarded, so a missing API reads "not available"
async function runChecks(): Promise<Row[]> {
  const pi = getPi();
  const rows: Row[] = [
    { label: 'User agent', value: navigator.userAgent },
    { label: 'Pi Browser (user agent)', value: isPiBrowser() ? 'yes' : 'no' },
    { label: 'window.Pi', value: pi ? 'yes' : 'no' },
    { label: 'Host', value: window.location.host },
  ];

  let features = NOT_AVAILABLE;
  if (pi?.nativeFeaturesList) {
    try {
      features = describe(await withTimeout(getNativeFeaturesList(), 5_000));
    } catch (error) {
      features = errorText(error);
    }
  }
  rows.push({ label: 'Pi nativeFeaturesList()', value: features });

  rows.push(
    {
      label: "'serviceWorker' in navigator",
      value: String('serviceWorker' in navigator),
    },
    {
      label: "'PushManager' in window",
      value: String('PushManager' in window),
    },
    {
      label: "'Notification' in window",
      value: String('Notification' in window),
    },
    {
      label: 'Notification.permission',
      value: 'Notification' in window ? Notification.permission : NOT_AVAILABLE,
    },
  );

  let permissionState = NOT_AVAILABLE;
  if (navigator.permissions?.query) {
    try {
      const status = await withTimeout(
        navigator.permissions.query({
          name: 'notifications' as PermissionName,
        }),
        5_000,
      );
      permissionState = status.state;
    } catch (error) {
      permissionState = errorText(error);
    }
  }
  rows.push({
    label: "permissions.query('notifications')",
    value: permissionState,
  });

  let standalone = NOT_AVAILABLE;
  try {
    standalone = String(
      window.matchMedia('(display-mode: standalone)').matches,
    );
  } catch (error) {
    standalone = errorText(error);
  }
  rows.push(
    { label: 'display-mode: standalone', value: standalone },
    {
      label: "'setAppBadge' in navigator",
      value: String('setAppBadge' in navigator),
    },
  );
  return rows;
}

// A local test notification: through an active service worker if there is one, as Android
// Chrome refuses new Notification() in pages. This app registers none, and serviceWorker.ready
// would wait for one forever, so it asks getRegistration() instead
async function showTestNotification(): Promise<string> {
  const title = 'Avante Maps test notification';
  if ('serviceWorker' in navigator) {
    try {
      const registration = await withTimeout(
        navigator.serviceWorker.getRegistration(),
        3_000,
      );
      if (registration?.active) {
        await registration.showNotification(title);
        return 'shown (service worker)';
      }
    } catch (error) {
      return `service worker: ${errorText(error)}`;
    }
  }
  try {
    new Notification(title);
    return 'shown (new Notification)';
  } catch (error) {
    return errorText(error);
  }
}

const DiagnosticsPage = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [sdkRows, setSdkRows] = useState<Row[]>([]);
  const [sdkTest, setSdkTest] = useState<string | null>(null);
  const [sdkAuth, setSdkAuth] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // After mount: none of this exists during the server render
  useEffect(() => {
    // First, before the checks below use the SDK
    setSdkRows(readPiSdk());
    // Only the script count is read again: the rest is the state the page opened with
    const recount = () =>
      setSdkRows((current) =>
        current.map((row) => (row.label === 'Pi SDK: pi-sdk.js script tags now' ? scriptTagsRow() : row)),
      );
    // The whole document: the head itself can be swapped during hydration. Only script changes count
    const isScript = (node: Node) => node.nodeName === 'SCRIPT';
    const scriptWatch = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes, ...r.removedNodes].some(isScript))) recount();
    });
    scriptWatch.observe(document.documentElement, { childList: true, subtree: true });
    recount();
    let cancelled = false;
    void runChecks().then((checked) => {
      if (!cancelled)
        setRows((current) => [
          ...checked,
          ...current.filter(
            (row) => !checked.some((c) => c.label === row.label),
          ),
        ]);
    });
    return () => {
      cancelled = true;
      scriptWatch.disconnect();
    };
  }, []);

  const setRow = useCallback((label: string, value: string) => {
    setRows((current) => {
      const exists = current.some((row) => row.label === label);
      return exists
        ? current.map((row) => (row.label === label ? { label, value } : row))
        : [...current, { label, value }];
    });
  }, []);

  const askNotificationPermission = async () => {
    setBusy('notification');
    try {
      if (!('Notification' in window) || !Notification.requestPermission) {
        setRow('Notification.requestPermission()', NOT_AVAILABLE);
        return;
      }
      const result = await withTimeout(
        Notification.requestPermission(),
        30_000,
      );
      setRow('Notification.requestPermission()', result);
      setRow('Notification.permission', Notification.permission);
      if (result === 'granted')
        setRow('Test notification', await showTestNotification());
    } catch (error) {
      setRow('Notification.requestPermission()', errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const tryPiPermission = async () => {
    setBusy('pi');
    const pi = getPi();
    try {
      if (!pi?.requestPermission) {
        setRow("Pi requestPermission('notifications')", NOT_AVAILABLE);
        return;
      }
      setRow(
        "Pi requestPermission('notifications')",
        describe(
          await withTimeout(
            withPiInit(() => pi.requestPermission!('notifications')),
            30_000,
          ),
        ),
      );
    } catch (error) {
      setRow("Pi requestPermission('notifications')", errorText(error));
    } finally {
      setBusy(null);
    }
  };

  // Calls Pi.nativeFeaturesList() the way the app calls the SDK (initialising the current
  // window.Pi first if it isn't, and once more on "not initialized"), and shows the result
  const testPiSdk = async () => {
    setBusy('sdk');
    try {
      const pi = (window as unknown as PiSdkWindow).Pi;
      if (!pi?.nativeFeaturesList) {
        setSdkTest(NOT_AVAILABLE);
        return;
      }
      setSdkTest(describe(await withTimeout(getNativeFeaturesList(), 10_000)));
    } catch (error) {
      setSdkTest(errorText(error));
    } finally {
      setSdkRows(readPiSdk());
      setBusy(null);
    }
  };

  // Authenticates the current window.Pi with the payment scopes (silent if the user already agreed),
  // and shows the scopes it has, or the error. Pi reports an unfinished payment while doing this
  const authenticateForPayments = async () => {
    setBusy('auth');
    try {
      const scopes = await withTimeout(ensurePiPaymentsAuth(), 60_000);
      setSdkAuth(scopes.length > 0 ? scopes.join(', ') : 'no scopes');
    } catch (error) {
      setSdkAuth(errorText(error));
    } finally {
      // The handler for an unfinished payment runs after authenticate resolves: read it a moment later
      window.setTimeout(() => setSdkRows(readPiSdk()), 500);
      setSdkRows(readPiSdk());
      setBusy(null);
    }
  };

  const sdkResultRows: Row[] = [
    ...sdkRows,
    ...(sdkTest !== null ? [{ label: 'Pi SDK: Test Pi SDK', value: sdkTest }] : []),
    ...(sdkAuth !== null ? [{ label: 'Pi SDK: Authenticate for payments', value: sdkAuth }] : []),
  ];

  const copyResults = async () => {
    const text = [...sdkResultRows, ...rows].map((row) => `${row.label}: ${row.value}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
      return;
    } catch {
      // The Pi Browser's webview may not allow it: try Pi's own copy
    }
    try {
      const pi = getPi();
      if (!pi?.copyText) throw new Error(NOT_AVAILABLE);
      await withPiInit(() => pi.copyText!(text));
      toast.success('Copied');
    } catch (error) {
      toast.error(
        `Couldn't copy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return (
    <AppLayout title="Diagnostics" backButton={true} hideBottomNav={true}>
      <Helmet>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div
        className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-8 pt-3"
        role="region"
        aria-labelledby="page-title"
      >
        <p className="text-sm text-muted-foreground">
          What this browser supports for notifications, and the Pi SDK's state.
          Nothing personal is shown.
        </p>
        <section aria-labelledby="pi-sdk-heading" className="space-y-2">
          <h2 id="pi-sdk-heading" className="text-base font-semibold">
            Pi SDK
          </h2>
          <dl
            className="divide-y divide-border rounded-xl border bg-card text-sm text-card-foreground"
            aria-busy={sdkRows.length === 0}
          >
            {sdkResultRows.map((row) => (
              <div key={row.label} className="grid gap-1 px-3 py-2.5" data-row={row.label}>
                <dt className="font-medium">{row.label.replace('Pi SDK: ', '')}</dt>
                <dd className="break-all font-mono text-muted-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            onClick={() => void testPiSdk()}
            disabled={busy !== null}
          >
            Test Pi SDK
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            onClick={() => void authenticateForPayments()}
            disabled={busy !== null}
          >
            Authenticate for payments
          </Button>
        </section>
        <h2 className="text-base font-semibold">Notifications</h2>
        <dl
          className="divide-y divide-border rounded-xl border bg-card text-sm text-card-foreground"
          aria-busy={rows.length === 0}
        >
          {rows.map((row) => (
            <div
              key={row.label}
              className="grid gap-1 px-3 py-2.5"
              data-row={row.label}
            >
              <dt className="font-medium">{row.label}</dt>
              <dd className="break-all font-mono text-muted-foreground">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            className="h-11"
            onClick={() => void askNotificationPermission()}
            disabled={busy !== null}
          >
            Ask for notification permission
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => void tryPiPermission()}
            disabled={busy !== null}
          >
            Try Pi permission
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => void copyResults()}
            disabled={rows.length === 0}
          >
            Copy results
          </Button>
        </div>
      </div>
    </AppLayout>
  );
};

// A developer page: admins only, as Notification Admin checks. Everyone else gets the 404 page,
// so it doesn't show that the page exists
const Diagnostics = () => {
  const { isAdmin, isLoading } = useAuth();

  // Loading only until we know: an admin's page stays mounted when auth reloads (e.g. after
  // Authenticate for payments), or its results would be lost
  if (isLoading && !isAdmin) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </AppLayout>
    );
  }

  if (!isAdmin) return <NotFound />;

  return <DiagnosticsPage />;
};

export default Diagnostics;
