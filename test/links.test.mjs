import test from 'node:test';
import assert from 'node:assert/strict';
import { isHttpUrl, splitHttpLinks, splitDetailLinks } from '../mods/trough/links.js';

test('only absolute HTTP(S) URLs with a host are openable', () => {
  assert.equal(isHttpUrl('https://example.com/path'), true);
  assert.equal(isHttpUrl('HTTP://example.com'), true);
  for (const value of ['/tmp/report', 'file:///tmp/report', 'javascript:alert(1)', 'ftp://example.com', 'https:///']) {
    assert.equal(isHttpUrl(value), false, value);
  }
});

test('splits prose around links while leaving trailing punctuation in the text', () => {
  assert.deepEqual(splitHttpLinks('See https://example.com/a, then (http://example.org/b).'), [
    {text: 'See '},
    {text: 'https://example.com/a', url: 'https://example.com/a'},
    {text: ', then ('},
    {text: 'http://example.org/b', url: 'http://example.org/b'},
    {text: ').'},
  ]);
  assert.deepEqual(splitHttpLinks('https://en.wikipedia.org/wiki/Function_(mathematics).'), [
    {text: 'https://en.wikipedia.org/wiki/Function_(mathematics)', url: 'https://en.wikipedia.org/wiki/Function_(mathematics)'},
    {text: '.'},
  ]);
});

test('leaves paths, other schemes and malformed URLs as plain text', () => {
  const text = 'file:///tmp/a ftp://example.com javascript:https://bad.test and https://';
  assert.deepEqual(splitHttpLinks(text), [{text}]);
});

test('detects absolute and home paths in details and preserves punctuation', () => {
  assert.deepEqual(splitDetailLinks('Read (/tmp/report.pdf), then ~/Notes/today.md.'), [
    {text: 'Read ('},
    {text: '/tmp/report.pdf', path: '/tmp/report.pdf'},
    {text: '), then '},
    {text: '~/Notes/today.md', path: '~/Notes/today.md'},
    {text: '.'},
  ]);
});

test('does not turn URL components or relative paths into local paths', () => {
  assert.deepEqual(splitDetailLinks('See https://example.com/a/b, file:///tmp/a, ./local and //server/share.'), [
    {text: 'See '},
    {text: 'https://example.com/a/b', url: 'https://example.com/a/b'},
    {text: ', file:///tmp/a, ./local and //server/share.'},
  ]);
});

