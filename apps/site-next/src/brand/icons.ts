/**
 * THE EIGHT LINE ICONS, AS DATA.
 *
 * PROVENANCE. `C:\Users\Micha\desktop\Rwally Brand\assets\icons\icon-*.svg`,
 * the final brand set of 2026-09-05, copied path-for-path. Every one is a
 * 24x24 box, `fill="none"`, `stroke-width="2"`, butt caps and miter joins —
 * checked here at copy time, and the reason the component below can hardcode
 * those four values instead of carrying them per icon.
 *
 * WHY THE PATHS AND NOT THE FILES. An icon rendered through `<img>` is an
 * isolated document: it cannot take `currentColor` from the text beside it, so
 * every icon would need a colour baked in and a second copy for every state it
 * ever sits in. Inline, one rule colours all eight. They are small enough for
 * that to be free — the largest is three path commands.
 *
 * THE BRAND SET GIVES EACH ICON A `<title>`, and those titles are descriptions
 * of the DRAWING ("A slab of value drops into the open mouth of the vault"),
 * not of the mechanism. They are deliberately NOT carried across: every icon
 * here sits beside the words it illustrates, so it is decorative, and a
 * description of a drawing read aloud before the sentence it decorates is noise
 * at best. `Icon` is `aria-hidden` and takes no label for that reason.
 */

/** One entry per icon: the path commands, in the order the brand file draws them. */
export const ICON_PATHS = {
  basket: ['M4 8H20V20H4Z', 'M10 8V20', 'M16 8V20'],
  commit: ['M4 9H20V20H4Z', 'M4 13H20'],
  deposit: ['M4 13V20H20V13', 'M12 4V15', 'M8 11L12 15L16 11'],
  execute: ['M4 6H11L17 14V18', 'M3 21H21'],
  fee: ['M4 9H20V19H4Z', 'M16 9V19'],
  propose: ['M4 14H20V20H4Z', 'M12 11V4', 'M8 8L12 4L16 8'],
  reveal: ['M4 9H20V20H4Z', 'M4 9L17 4'],
  stockToken: ['M6 3H18V21H6Z', 'M6 8H18'],
} as const;

export type IconName = keyof typeof ICON_PATHS;
