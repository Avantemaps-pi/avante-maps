/**
 * router-compat's useLocation, rendered with a real TanStack router (memory history, no
 * browser): search has exactly one leading "?", as react-router's does.
 */
import { test, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useLocation } from '../../src/lib/router-compat';

async function searchAt(url: string) {
  let seen: string | undefined;
  const Probe = () => {
    seen = useLocation().search;
    return null;
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: Probe }),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  renderToString(createElement(RouterProvider, { router } as never));
  return seen;
}

test('search has one leading "?"', async () => {
  expect(await searchAt('/communicon?confirm_code=123456&business=1')).toBe('?confirm_code=123456&business=1');
});

test('search is empty without a query', async () => {
  expect(await searchAt('/communicon')).toBe('');
});
