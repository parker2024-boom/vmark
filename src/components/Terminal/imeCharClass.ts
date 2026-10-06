/**
 * imeCharClass
 *
 * Purpose: the ASCII / non-ASCII detectors shared by the terminal IME layer
 * (setupImeCompositionGate, terminalSessionInputWiring), consolidated into ONE
 * definition instead of near-identical copies.
 *
 * Written with the `\p{ASCII}` property escape, NOT a literal U+0080–U+FFFF
 * range: the literal form is correct but its leading U+0080 (a C1 control
 * character) renders invisibly in browsers, terminals, and review tools, making
 * the regex look like `/[-￿]/` and triggering false "matches only `-` and `￿`"
 * bug reports (#910). The property escape names the boundary (0x7F) without
 * spelling any control character, so the regexes need no lint exemption. With
 * the `u` flag a lone surrogate is still a non-ASCII code point, so `.test()`
 * answers exactly as the code-unit form did.
 *
 * @module components/Terminal/imeCharClass
 */

/** True if the string contains ANY character above 0x7F (BMP CJK, punctuation…). */
export const NON_ASCII_RE = /\P{ASCII}/u;

/** True if the string is entirely ASCII (one or more chars). */
export const ALL_ASCII_RE = /^\p{ASCII}+$/u;
