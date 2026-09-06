/**
 * EVERY PICTURE ON THIS SITE, DECLARED IN ONE PLACE.
 *
 * WHY A MANIFEST RATHER THAN A PATH IN EACH SECTION. The visual language moved
 * four times on 2026-09-05: an abstract photographic set, then the owner's
 * illustrated "Comic" direction with a designed mascot, then the v3 brief, which
 * kept the imagery and threw away the pages it sat on, then revision 2 of that
 * brief, which named artificialinu.com as the reference. Every one of those was
 * an edit to this file and to `public/media/`, and to nothing else. No section
 * imports a filename and no stylesheet names one.
 *
 * WHAT REVISION 2 CHANGED HERE: THERE IS NO MOVING SLOT ANY MORE.
 *
 * The previous pass had three video files: the hero's ambient loop and two
 * trailer clips used as section breaks. All three are gone, with the
 * `MotionBackdrop` component that played them and the `index-beats` section that
 * carried two of them. The reference's hero is a near-black ground with a
 * drifting point field and nothing else moving behind the type, and the owner
 * named it as "90% what im looking for", so the star field in
 * `src/assets/Particles.tsx` is what is behind the headline now.
 *
 * THE CONSEQUENCE REACHES THE CONTENT SECURITY POLICY, and that is the honest
 * measure of the change rather than a side note. `media-src` existed in
 * `public/_headers` for exactly one reason, which was `/media/loop-1280.mp4`.
 * This origin now serves no video at all, so the directive falls back to
 * `default-src 'none'` and the site cannot load a media element even if one were
 * added by accident.
 *
 * SO ONE PICTURE REMAINS, AND IT IS USED TWICE. `mascot` is the character in the
 * hive section, where it is an `<img>` with alt text describing what is drawn,
 * and the full-bleed parallax ground in the footer, where it is decoration with
 * an empty alt. Same file, two crops, one download.
 *
 * PROVENANCE. `mascot` comes from `Rwally Brand/`, the final brand set of
 * 2026-09-05, by way of the Higgsfield website prototype's Agents plate
 * (`Rwally Higgsfield/website/assets/operator-mascot-16x9.png`, 2752x1536).
 *
 * IT CARRIES NO TEXT, so it adds no claim to any section it sits in. That is
 * checked rather than assumed: the frame was opened and looked at on 2026-09-05
 * and carries no lettering, number, logo, ticker or chart. ANY REPLACEMENT OWES
 * THE SAME CHECK, because an image with words in it is published copy that no
 * claims guard reads.
 *
 * HOW THE FILE WAS MADE. The source PNG was resized with `ffmpeg` (8.1.2,
 * lanczos) and encoded to WebP at quality 74, compression level 6, at 1280 and
 * 1920 CSS pixels wide. Measured sizes, 2026-09-05: 122,438 B at 1280 and
 * 256,150 B at 1920, from 2752x1536 less a 1.2% crop.
 */

/** A still slot: two widths of the same picture, and its intrinsic box. */
export type Still = {
  /** The 1280-wide file, used as the `src` for a browser that ignores srcset. */
  readonly src: string;
  /** Both widths, with their real pixel widths, for the browser to choose from. */
  readonly srcSet: string;
  /** The 1920 file's real dimensions, so the box is reserved before it loads. */
  readonly width: number;
  readonly height: number;
};

const media = (name: string, w: number, h: number): Still => ({
  src: `/media/${name}-1280.webp`,
  srcSet: `/media/${name}-1280.webp 1280w, /media/${name}-1920.webp 1920w`,
  width: w,
  height: h,
});

/**
 * The still slots. One: the mascot plate.
 *
 * The Rwally agent under a violet shaft, hooded, bone-white featureless mask
 * with one ledger rule at eye level, floor-length coat, small in the frame and
 * not gesturing. The left two thirds are flat black, which is what lets the same
 * plate serve as a character on the right of a two-column section and as a
 * ground a footer's type can sit on.
 *
 * A 1.2% edge is cropped off every side before encoding, because the frame
 * carries a bone-white panel border that `object-fit: cover` would draw as a
 * bright hairline along the top and bottom of the section.
 */
export const STILLS = {
  /** index.html: the hive section's character, and the footer's ground. */
  mascot: media('mascot', 1920, 1072),
} as const;

export type StillId = keyof typeof STILLS;
