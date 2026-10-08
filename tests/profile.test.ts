import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { selectProfile } = require('../electron/profile.cjs');
const userData = path.resolve('/tmp/profile-test/DialDev');

describe('DialDev profile', () => {
  it('uses a stable DialDev directory, origin, and credential vault', () => {
    expect(selectProfile({ userData })).toEqual({ directory: userData, scheme: 'dialdev', vault: 'vault' });
  });
  it('isolates test runs from the user profile', () => {
    const testData = path.resolve('/tmp/profile-test/isolated');
    expect(selectProfile({ userData, testData })).toEqual({ directory: testData, scheme: 'dialdev', vault: 'vault' });
  });
});
