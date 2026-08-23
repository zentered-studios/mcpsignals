import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../dist/index.mjs';

test('error_kind: null when there is no message', () => {
  assert.equal(classifyError(undefined), null);
  assert.equal(classifyError(null), null);
  assert.equal(classifyError(''), null);
});

test('error_kind: not_found bucket', () => {
  assert.equal(classifyError('Resource not found'), 'not_found');
  assert.equal(classifyError('User does not exist'), 'not_found');
});

test('error_kind: empty bucket', () => {
  assert.equal(classifyError('Search returned no results'), 'empty');
  assert.equal(classifyError('The result set was empty'), 'empty');
});

test('error_kind: validation bucket', () => {
  assert.equal(classifyError('Invalid argument: limit'), 'validation');
  assert.equal(classifyError('field is required'), 'validation');
});

test('error_kind: internal bucket is the default', () => {
  assert.equal(classifyError('connection reset by peer'), 'internal');
  assert.equal(classifyError('database connection timed out'), 'internal');
});

test('error_kind: documented false-positive — an internal error whose text contains "not found"', () => {
  // See schema/events.md: this is a known, accepted limitation of the heuristic.
  assert.equal(classifyError("config key 'timeout' not found in environment"), 'not_found');
});
