/**
 * Byte-identical copy of `TRIVIAL_CHANGE` in `plugins/typesafe/src/size.ts`;
 * `size-definition.test.ts` holds the two together. Nothing is imported at
 * runtime: the plugins ship separately.
 */
export const TRIVIAL_CHANGE =
  "Trivial: one file, a few lines, the exact change already settled, and no design choice the user has not seen. Anything else that changes code or config is non-trivial.";
