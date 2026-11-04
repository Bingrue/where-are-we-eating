import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { account, startApi } from './support.js';

test('two browser sessions can join, suggest, vote live and view a saved result', { timeout: 75_000 }, async (t) => {
  const api = await startApi(fileURLToPath(new URL('../client/dist/', import.meta.url)));
  t.after(() => api.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const host = await browser.newPage();
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const guestAccount = await account();
  const suffix = randomUUID().slice(0, 8);
  const groupName = 'Friday dinner ' + suffix;
  const question = 'Where should we eat tonight?';

  await host.goto(api.origin);
  await host.getByRole('button', { name: 'New here? Create an account' }).click();
  await host.getByLabel('Display name').fill('Dinner host');
  await host.getByLabel('Email').fill('host-' + suffix + '@example.com');
  await host.getByLabel('Password').fill('Dinner!' + randomUUID());
  await host.getByRole('button', { name: 'Create account', exact: true }).click();
  await host.getByRole('heading', { name: 'Pull up a chair.' }).waitFor();

  await host.getByLabel('Group name').fill(groupName);
  await host.getByRole('button', { name: 'Create group', exact: true }).click();
  await host.getByRole('heading', { name: groupName }).waitFor();
  await host.getByRole('button', { name: 'Show invite' }).click();
  const invite = await host.getByLabel('Invitation link').inputValue();
  assert.match(invite, /\?invite=[0-9a-f]{32}$/);
  await host.getByLabel('Question').fill(question);
  await host.getByRole('button', { name: 'Create poll' }).click();
  await host.getByRole('heading', { name: question }).waitFor();
  const pollUrl = host.url();
  await host.getByLabel('Restaurant name').fill('Juniper Bistro');
  await host.getByLabel('Food category').fill('French');
  await host.getByRole('button', { name: 'Add restaurant' }).click();
  await host.getByRole('heading', { name: 'Juniper Bistro' }).waitFor();

  await guest.goto(invite);
  await guest.getByLabel('Email').fill(guestAccount.email);
  await guest.getByLabel('Password').fill(guestAccount.password);
  await guest.getByRole('button', { name: 'Sign in', exact: true }).click();
  await guest.getByRole('button', { name: 'Join group' }).click();
  await guest.getByRole('link', { name: new RegExp(question.replace('?', '\\?')) }).click();
  await guest.getByText('Live updates', { exact: true }).waitFor();
  await host.getByText('Live updates', { exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: 'Close poll' }).count(), 0);

  const sent = performance.now();
  await guest.getByRole('button', { name: 'Vote for Juniper Bistro' }).click();
  await host.getByText('1 vote cast', { exact: true }).waitFor();
  t.diagnostic('Browser-to-browser vote visibility ' + Math.round(performance.now() - sent) + ' ms');
  await guest.getByText('You’ve voted', { exact: false }).waitFor();
  await host.getByRole('button', { name: 'Close poll', exact: true }).click();
  await host.getByRole('button', { name: 'Confirm close' }).click();
  await guest.getByText('Final result', { exact: true }).waitFor();
  await guest.getByRole('heading', { name: 'Juniper Bistro', exact: true, level: 2 }).waitFor();
  await guest.goto(pollUrl);
  await guest.getByText('Final result', { exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: 'Vote for Juniper Bistro' }).count(), 0);
});
