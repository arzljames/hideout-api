import { z } from 'zod';

// The regexes below need the `v` flag (set subtraction, \p{RGI_Emoji}), which Node 22+ supports
// but TypeScript only accepts in literals when targeting ES2024, so they are built with RegExp.

/** Every RGI emoji (including ZWJ sequences and tag-sequence flags like 🏴󠁧󠁢󠁳󠁣󠁴󠁿), stripped before the checks below. */
const RGI_EMOJI = new RegExp(String.raw`\p{RGI_Emoji}`, 'gv');

/**
 * Characters that can hide text, reorder it, or look blank, outside an emoji: format characters
 * (\p{Cf}: zero-width chars, bidi marks/embeddings/overrides/isolates, soft hyphen, U+061C,
 * U+180E, interlinear annotations, the BOM, stray tag characters, ...) except the zero-width
 * joiner, controls, line/paragraph separators, and the Hangul fillers and braille blank.
 * Tag characters and ZWJs inside an RGI emoji are removed first, so those emoji stay valid.
 */
const FORBIDDEN_CHARS = new RegExp(
  String.raw`[[\p{Cf}\p{Cc}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀]--[‍]]`,
  'v',
);

/** A letter, number, symbol, or punctuation mark that actually renders (not a blank-looking filler). */
const VISIBLE_CHAR = new RegExp(String.raw`[[\p{L}\p{N}\p{S}\p{P}]--[ᅟᅠㅤﾠ⠀]]`, 'v');

/** The character rules shared by every display-name description, for `.openapi({ description })`. */
export const DISPLAY_NAME_RULES =
  'Normalized to Unicode NFC before the length check (composed and decomposed forms are the same name). ' +
  'Must contain at least one visible letter, number, symbol, or punctuation mark. Outside RGI emoji, format ' +
  'characters (Unicode Cf, e.g. zero-width and bidi control characters, soft hyphen, U+FEFF, tag characters), ' +
  'control characters (Cc), line and paragraph separators (Zl, Zp), and the blank-looking U+115F, U+1160, ' +
  'U+3164, U+FFA0, and U+2800 are rejected; U+200D zero-width joiner is allowed for emoji.';

function hasForbiddenChars(value: string): boolean {
  return FORBIDDEN_CHARS.test(value.replace(RGI_EMOJI, ''));
}

/**
 * A user-chosen name shown to other members (rooms, channels): trimmed, NFC-normalized,
 * 1–`max` UTF-16 code units, at least one visible character, and no invisible, bidi, or
 * blank-looking characters. Callers add `.openapi()`.
 *
 * Refines, not .regex(): the Unicode property escapes need the `v` flag, which the OpenAPI
 * `pattern` can't express portably.
 */
export function displayName(max: number) {
  return z
    .string()
    .trim()
    .normalize('NFC')
    .min(1, 'Name is required.')
    .max(max, `Name must be at most ${max} characters.`)
    .refine((value) => !hasForbiddenChars(value), "Name can't contain invisible, blank, or text-direction control characters.")
    .refine((value) => VISIBLE_CHAR.test(value), 'Name must contain a letter, number, symbol, or punctuation mark.');
}
