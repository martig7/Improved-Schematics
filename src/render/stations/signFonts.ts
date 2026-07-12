/**
 * font-family stacks for the Japanese-sign station designs. The first family
 * in each stack is a bundled face registered by ui/fonts.ts at panel init;
 * the rest is the renderer's default fallback stack, so environments without
 * the bundled fonts still render.
 */

/** Sign LETTERS (route bullets): Open Sans Bold. */
export const SIGN_LETTER_FONT = '"Open Sans", Helvetica, "Helvetica Neue", Arial, sans-serif';

/** Sign DIGITS (station numbers): same face as the letters. Kept as its own
 *  constant so a digit-specific face stays a one-line change. */
export const SIGN_DIGIT_FONT = SIGN_LETTER_FONT;
