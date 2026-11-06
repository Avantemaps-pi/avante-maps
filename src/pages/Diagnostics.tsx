import React, { useCallback, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { toast } from 'sonner';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { isPiBrowser } from '@/utils/piNetwork';

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
      features = describe(await withTimeout(pi.nativeFeaturesList(), 5_000));
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

const Diagnostics = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // After mount: none of this exists during the server render
  useEffect(() => {
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
          await withTimeout(pi.requestPermission('notifications'), 30_000),
        ),
      );
    } catch (error) {
      setRow("Pi requestPermission('notifications')", errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const copyResults = async () => {
    const text = rows.map((row) => `${row.label}: ${row.value}`).join('\n');
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
      await pi.copyText(text);
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
          What this browser supports for notifications. Nothing personal is
          shown.
        </p>
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

export default Diagnostics;
