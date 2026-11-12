import test from 'node:test';
import assert from 'node:assert/strict';
import { isHttpUrl, splitHttpLinks } from '../mods/trough/links.js';

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

