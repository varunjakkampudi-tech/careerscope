export * from './commands.js';
export * from './database.js';
export * from './schema.js';
export * from './queue.js';
export * from './dispatch.js';
export * from './jobs.js';
export * from './auth.js';
export * from './runtime.js';
export * from './profile.js';
export * from './preparation.js';
export * from './leads.js';
export * from './bull-queue.js';
export * from './storage.js';
export * from './file-storage.js';
export * from './resumes.js';
export * from './resume-parser.js';
export * from './market.js';
// ai-provider.js and ai-assist.js are DELIBERATELY NOT RE-EXPORTED HERE
// (CS-48 re-review, finding 4). The structural isolation test proves that no
// deterministic module in this package mentions 'ai-provider' or 'ai-assist' -
// but while this barrel re-exported both, a sibling could have written
// `import { elaborate } from './index.js'` and contained neither string. The
// hole is closed by removing the route, not by testing for it: the AI modules
// are reachable only through the explicit '@careerscope/core/ai-provider' and
// '@careerscope/core/ai-assist' subpaths, which the same test now refuses in a
// sibling as well. Consumers outside this package (apps/api) import them by
// subpath on purpose - the import then says what it is doing.
