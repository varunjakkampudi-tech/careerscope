import { z } from 'zod';

// The production CSP has no 'unsafe-eval'. zod otherwise probes for `new Function` support while
// building its first object schema; the probe is caught, but Firefox still reports each blocked
// eval as a console error (and a securitypolicyviolation event). `jitless` skips the probe and
// uses zod's interpreted parser, which is the same validation without code generation.
// This module must be imported before any module that builds a zod schema (including
// @careerscope/shared), so import it first.
z.config({ jitless: true });
