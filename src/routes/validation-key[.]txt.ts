import { createFileRoute } from '@tanstack/react-router';
import { getPiValidationKey } from '@/config/piValidationKeys';

// Pi fetches this to verify the app's domain; the key depends on which domain asked.
// X-Forwarded-Host first (Vercel's proxy), then Host.
export const Route = createFileRoute('/validation-key.txt')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const host =
          request.headers.get('x-forwarded-host') ??
          request.headers.get('host');
        return new Response(`${getPiValidationKey(host)}\n`, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0, s-maxage=0, must-revalidate',
          },
        });
      },
    },
  },
});
