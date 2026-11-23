import test from 'node:test';
import assert from 'node:assert/strict';

import { banglaChannelName, banglaGroupName, normalizeName, searchTerms } from '../lib/bangla.js';
import { groupSummary } from '../lib/channels.js';

test('known channels get a Bangla name', () => {
  assert.equal(banglaChannelName('Somoy TV'), 'সময় টিভি');
  assert.equal(banglaChannelName('SOMOY  tv'), 'সময় টিভি');
  assert.equal(banglaChannelName('Channel i'), 'চ্যানেল আই');
  assert.equal(banglaChannelName('Deepto TV'), 'দীপ্ত টিভি');
  assert.equal(banglaChannelName('Star Jalsha'), 'স্টার জলসা');
  assert.equal(banglaChannelName('Zee Bangla'), 'জি বাংলা');
  assert.equal(banglaChannelName('Star Sports 1 Hindi'), 'স্টার স্পোর্টস ১ হিন্দি');
});

test('quality suffixes still resolve to the Bangla name', () => {
  assert.equal(banglaChannelName('Star Jalsha HD'), 'স্টার জলসা');
  assert.equal(banglaChannelName('Sony SAB HD'), 'সনি সাব');
  assert.equal(banglaChannelName('Zee TV 4K'), 'জি টিভি');
});

test('unknown channels fall back to null so the source name is kept', () => {
  assert.equal(banglaChannelName('Random Channel 42'), null);
  assert.equal(banglaChannelName(''), null);
  assert.equal(banglaChannelName(null), null);
});

test('group titles are translated, including compound ones', () => {
  assert.equal(banglaGroupName('Bangla News'), 'বাংলা সংবাদ');
  assert.equal(banglaGroupName('Hindi Entertainment'), 'হিন্দি বিনোদন');
  assert.equal(banglaGroupName('Sports'), 'খেলাধুলা');
  assert.equal(banglaGroupName('Devotional'), 'ধর্মীয়');
  assert.equal(banglaGroupName('Bangla Entertainment HD'), 'বাংলা বিনোদন');
  assert.equal(banglaGroupName('Tamil Movies'), 'তামিল সিনেমা');
  assert.equal(banglaGroupName('Zzz'), null);
  assert.equal(banglaGroupName(''), null);
});

test('search terms cover English, Bangla and the group label', () => {
  const terms = searchTerms({ id: 'somoy-tv', name: 'Somoy TV', group: 'Bangla News', language: 'Bangla' });
  assert.ok(terms.includes('Somoy TV'));
  assert.ok(terms.includes('সময় টিভি'));
  assert.ok(terms.includes('বাংলা সংবাদ'));
  assert.ok(terms.includes('somoy-tv'));
  assert.ok(!terms.includes(undefined));
});

test('normalizeName strips punctuation, & and +', () => {
  assert.equal(normalizeName('Star & Movies +'), 'starandmoviesplus');
  assert.equal(normalizeName('  News-24  '), 'news24');
});

test('groupSummary carries the Bangla label', () => {
  const summary = groupSummary([
    { group: 'Bangla News' },
    { group: 'Bangla News' },
    { group: 'Movies' },
    { group: 'Unknown Group' },
  ]);
  assert.deepEqual(
    summary.map((entry) => [entry.name, entry.count, entry.labelBn]),
    [
      ['Bangla News', 2, 'বাংলা সংবাদ'],
      ['Movies', 1, 'সিনেমা'],
      ['Unknown Group', 1, null],
    ],
  );
});
