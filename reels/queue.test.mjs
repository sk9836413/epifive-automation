import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem, dueItem, recordResult } from './queue.mjs';

const now = new Date('2026-11-17T01:00:00Z');

test('an item is due at its time, not before, and expires after 20 hours', () => {
  const items = [];
  addItem(items, { slug: 'wifi-fix', run: '123', artifact: 'social-wifi-fix', due: '2026-11-17T00:30:00Z' });
  addItem(items, { slug: 'later', run: '124', artifact: 'social-later', due: '2026-11-18T00:30:00Z' });
  assert.equal(dueItem(items, new Date('2026-11-17T00:10:00Z')), null);
  assert.equal(dueItem(items, now).slug, 'wifi-fix');
  assert.equal(dueItem(items, new Date('2026-11-17T21:00:00Z')), null);
  assert.equal(items[0].status, 'expired');
});

test('the same slug is queued once; bad input is refused', () => {
  const items = [];
  addItem(items, { slug: 'a', run: '1', artifact: 'social-a', due: '2026-11-17T00:30:00Z' });
  addItem(items, { slug: 'a', run: '2', artifact: 'social-a', due: '2026-11-17T00:30:00Z' });
  assert.equal(items.length, 1);
  assert.throws(() => addItem(items, { slug: 'A b', run: '1', artifact: 'x', due: 'soon' }));
});

test('a posted Reel gives a log line the comment-reply job can map; failures retry 3 times', () => {
  const items = [];
  addItem(items, { slug: 'a', run: '1', artifact: 'social-a', due: '2026-11-17T00:30:00Z' });
  assert.equal(recordResult(items, 'a', { status: 'partial-failure', instagram: { error: 'rupload failed' } }, now), null);
  assert.equal(items[0].status, 'pending');
  const line = recordResult(items, 'a', { status: 'ok', instagram: { id: '9', url: 'https://www.instagram.com/reel/AbC/' } }, now);
  assert.equal(line, '- 2026-11-17 | a | ig-en: https://www.instagram.com/reel/AbC/');
  assert.equal(items[0].status, 'posted');
  const b = [];
  addItem(b, { slug: 'b', run: '1', artifact: 'social-b', due: '2026-11-17T00:30:00Z' });
  for (let i = 0; i < 3; i++) recordResult(b, 'b', { status: 'error', error: 'x' }, now);
  assert.equal(b[0].status, 'error');
});
