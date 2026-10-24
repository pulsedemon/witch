import { afterAll, beforeEach, vi } from 'vitest';
import { cleanScratch } from './scratch.js';

beforeEach((context) => {
  context.onTestFinished(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});
afterAll(cleanScratch);
