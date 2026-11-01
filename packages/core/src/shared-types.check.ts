/**
 * Compile-time only. The web client names these shapes through `@careerscope/shared` so it never imports
 * this package; this file fails the type check if a Zod schema here drifts from the shared declaration.
 */

import type {
  AssertSame,
  CollectedJob as SharedCollectedJob,
  CreateSearch as SharedCreateSearch,
  WritableProfile as SharedWritableProfile,
} from '@careerscope/shared';
import type { CreateSearch } from './commands.js';
import type { CollectedJob } from './jobs.js';
import type { WritableProfile } from './profile.js';

type Expect<T extends true> = T;

export type SharedShapesInSync = [
  Expect<AssertSame<CreateSearch, SharedCreateSearch>>,
  Expect<AssertSame<CollectedJob, SharedCollectedJob>>,
  Expect<AssertSame<WritableProfile, SharedWritableProfile>>,
];
