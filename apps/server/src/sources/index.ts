import type { SourceAdapter } from './source';
import { youtube } from './youtube/adapter';

/** The video platforms the official build accepts. */
export const sources: readonly SourceAdapter[] = [youtube];
