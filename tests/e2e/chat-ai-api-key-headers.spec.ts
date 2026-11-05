/**
 * Regression test for the CommuniCon AI-mode request to the chat-ai edge
 * function.
 *
 * streamAIResponse() (useChatState.tsx) used a hand-written fetch with only a
 * Content-Type header, so the Supabase gateway rejected every request with
 * "Missing authorization header" — AI chat failed for everyone. The fetch now
 * sends the publishable key as `apikey` and the user's access token (when
 * there is a Supabase session) as `Authorization: Bearer`. A publishable key
 * is not a JWT, so it must never be sent as the Bearer token.
 *
 * Runs signed out: there is no Supabase session to pull a token from, so the
 * request must carry `apikey` only. The chat-ai call is intercepted and
 * answered locally — nothing reaches the real function.
 */
import { test, expect } from '@playwright/test';

test('chat-ai request sends the publishable key as apikey, never as Bearer', async ({ page }) => {
  await page.route('**/pi-sdk.js', (route) => route.abort());

  let captured: Record<string, string> | null = null;
  await page.route('**/functions/v1/chat-ai', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.continue();
    captured = route.request().headers();
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' },
      body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    });
  });

  // Bot, as if it was the tab picked earlier in the session
  await page.addInitScript(() => sessionStorage.setItem('communicon-tab', 'ai'));
  await page.goto('/communicon');

  const input = page.getByPlaceholder('Ask about your business...');
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  // SSR renders the input before hydration; a fill made too early is wiped.
  // The send button only enables once React state holds the text.
  const sendButton = page.getByRole('button', { name: 'Send' });
  await expect(async () => {
    await input.fill('What are your opening hours?');
    await expect(sendButton).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await input.press('Enter');

  await expect.poll(() => captured, { timeout: 15_000 }).not.toBeNull();
  const headers = captured as unknown as Record<string, string>;
  expect(headers['apikey']).toMatch(/^sb_publishable_/);
  expect(headers['authorization']).toBeUndefined();
});
