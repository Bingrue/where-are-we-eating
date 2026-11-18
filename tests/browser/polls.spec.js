import { test, expect } from '@playwright/test';
const poll = '/polls/11111111-1111-4111-8111-111111111111';

test('two pages suggest, vote, change vote, reconnect and persist the final result', async ({ context, page }) => {
  // Two independent pages/sessions share the mock datastore, as a database would.
  const guest = await context.newPage();
  await page.goto(`${poll}?actor=host`);
  await guest.goto(`${poll}?actor=guest`);
  await expect(guest.getByText('Live updates', { exact: true })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Close poll', exact: true })).toHaveCount(0);
  await page.getByLabel('Restaurant name', { exact: true }).fill('Juniper Bistro');
  await page.getByLabel('Food category').fill('Italian');
  await page.getByRole('button', { name: 'Add restaurant' }).click();
  await expect(guest.getByRole('heading', { name: 'Juniper Bistro' })).toBeVisible();
  await guest.getByRole('button', { name: 'Vote for Juniper Bistro' }).click();
  await expect(page.getByText('1 vote cast', { exact: true })).toBeVisible();
  await page.getByLabel('Restaurant name', { exact: true }).fill('Noodle House');
  await page.getByRole('button', { name: 'Add restaurant' }).click();
  await guest.getByRole('button', { name: 'Vote for Noodle House' }).click();
  await expect(guest.getByRole('button', { name: 'Vote for Noodle House' })).toHaveText('Selected');
  await expect(page.getByText('1 vote cast', { exact: true })).toBeVisible();
  await page.evaluate(() => window.fixture.disconnect());
  await expect(page.getByRole('status')).toContainText('Reconnecting');
  await guest.getByRole('button', { name: 'Vote for Juniper Bistro' }).click();
  await page.evaluate(() => window.fixture.reconnect());
  await expect(page.locator('li').filter({ has: page.getByRole('heading', { name: 'Juniper Bistro' }) }).getByText('1 vote', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/poll-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Close poll', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm close' }).click();
  await expect(guest.getByText('Final result', { exact: true })).toBeVisible();
  await expect(guest.getByRole('button', { name: /Vote for/ })).toHaveCount(0);
  await guest.reload();
  await expect(guest.locator('.notice')).toContainText('Juniper Bistro');
});

test('mobile create flow, RPC error and offline controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Poll question').fill('Friday lunch');
  await page.getByRole('button', { name: 'Create poll' }).click();
  await expect(page.getByRole('heading', { name: 'Friday lunch' })).toBeVisible();
  await page.getByLabel('Restaurant name', { exact: true }).fill('Ramen');
  await page.getByRole('button', { name: 'Add restaurant' }).click();
  await page.evaluate(() => window.fixture.rejectNextVote());
  await page.getByRole('button', { name: 'Vote for Ramen' }).click();
  await expect(page.getByRole('alert')).toContainText('not available yet');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('button', { name: 'Vote for Ramen' })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Vote for Ramen' }).click();
  await expect(page.getByText('1 vote cast · You’ve voted', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/poll-mobile.png', fullPage: true });
});
