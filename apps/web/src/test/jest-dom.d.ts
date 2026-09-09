/**
 * Type augmentation for the jest-dom matchers.
 *
 * The matchers themselves work at runtime — `@testing-library/jest-dom/vitest`
 * calls `expect.extend` in `vitest.setup.ts`, and the assertions pass. What does
 * not work is the *types*, and the reason is narrow enough to be worth writing
 * down so nobody deletes this file assuming it is redundant.
 *
 * jest-dom 7 ships this augmentation:
 *
 *     declare module 'vitest' {
 *       interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
 *     }
 *
 * Vitest 5 declares `interface Assertion<R extends void | Promise<void> = void,
 * T = unknown>` — two type parameters. TypeScript merges interface declarations
 * only when their type parameter lists are identical, so the one-parameter
 * version above does not merge. It fails *silently*: no error at the
 * declaration, just `Property 'toBeInTheDocument' does not exist` at every call
 * site.
 *
 * So the augmentation is redone here against `Matchers`, which is Vitest's
 * documented extension point and which `Assertion`, `ExpectStatic`, and
 * `AsymmetricMatchersContaining` all extend — one declaration covers all three.
 * The parameter list below must stay character-for-character identical to
 * Vitest's or this file goes quiet in exactly the same way.
 *
 * Delete this when jest-dom ships an augmentation matching Vitest 5's arity.
 */

import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  /*
   * Three rules fire on the line below, and all three are asking for something
   * that would break the merge:
   *
   *  - `no-empty-object-type` — an augmentation that adds members of its own
   *    would not be an augmentation.
   *  - `no-unused-vars` on `T` — TypeScript merges interfaces only when the type
   *    parameter *names* match, so `T` has to be spelled out and cannot be
   *    renamed to `_T`.
   *  - `no-explicit-any` — the element slot. jest-dom's own declaration uses
   *    `any` here; narrowing it would reject valid `expect(svgElement)` calls.
   */
  /* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends TestingLibraryMatchers<any, R> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
}

export {};
