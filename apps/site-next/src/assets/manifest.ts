/**
 * EVERY PICTURE ON THIS SITE, DECLARED IN ONE PLACE.
 *
 * WHY A MANIFEST RATHER THAN A PATH IN EACH SECTION. The visual language moved
 * twice on 2026-09-05. The site carried an abstract photographic set; the owner
 * then chose an illustrated "Comic" direction with a designed mascot, and the
 * brand pass delivered the finished set the same day. Both swaps were an edit to
 * this file and to `public/media/`, and to nothing else. No section imports a
 * filename, no stylesheet names one, and every consumer goes through
 * `Backdrop`.
 *
 * SO THE SLOT IDS ARE THE CONTRACT, not the filenames. `howItWorks`,
 * `immutability`, `lifecycle`, `agents` and `next` are places on pages; the
 * files they point at are this week's answer to them.
 *
 * THE index HERO IS NOT A SLOT HERE. It carries the clip, through
 * `MotionBackdrop`, which reads `LOOP` below rather than `STILLS`.
 *
 * PROVENANCE. Everything below comes from `C:\Users\Micha\desktop\Rwally Brand\`,
 * the final brand set of 2026-09-05 — `assets/hero/hero-a-21x9.png`, the four
 * `assets/sections/*-16x9.png`, `assets/motion/loop-16x9-seamless.mp4` and its
 * poster, and `assets/og/og-card-1200x630.png`, which is `public/og-card.png`
 * verbatim at 1,200x630 and 785,079 B. The abstract set that stood here earlier
 * in the day, and the logo panel before it, are gone from the desktop and are
 * referenced nowhere in this repository.
 *
 * THESE IMAGES CARRY NO TEXT, so they add no claim to any page they sit behind.
 * That is checked rather than assumed: every frame below was opened and looked
 * at on 2026-09-05. None carries lettering, a number, a logo, a ticker or a
 * chart. ANY REPLACEMENT SET OWES THE SAME CHECK: an image with words in it is
 * published copy that no claims guard reads.
 *
 * DECORATIVE, ALWAYS. Every slot renders with `alt=""` inside an `aria-hidden`
 * wrapper. None of them carries information, and an image that carried
 * information would need copy under it instead — copy is what this site's
 * guards can read.
 *
 * HOW THE FILES WERE MADE. Each source PNG was resized with `ffmpeg` (8.1.2,
 * lanczos) and encoded to WebP at quality 74, compression level 6, at 1280 and
 * 1920 CSS pixels wide; the clip was scaled to 1280 and re-encoded H.264 at
 * CRF 30, audio dropped, `+faststart`. Measured sizes, 2026-09-05:
 *
 *   immutability 125,124 / 237,362 B   (from 1920x1080)
 *   propose       91,978 / 170,316 B   (from 1920x1080)
 *   deposit       84,850 / 155,780 B   (from 1920x1080, currently unused)
 *   hero-b        56,866 / 102,158 B   (from 3360x1440)
 *   mascot       122,438 / 256,150 B   (from 2752x1536 less a 1.2% crop)
 *   next         100,108 / 184,152 B   (from 1920x1080)
 *   loop-poster   38,056 B at 1280     (from 1920x1080)
 *   loop         301,702 B at 1280x720, 7.54 s   (from 3,244,318 B)
 *
 * ONE FILE HAS NO WEBP AND THAT IS THE POINT: `loop-1280.mp4` is the only thing
 * on this site the CSP's `media-src 'self'` permits, and it is fetched only by a
 * reader who has not asked for reduced motion. See `Backdrop.tsx`.
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

/** The one moving slot: a clip, and the still a reduced-motion reader gets instead. */
export type Motion = Still & {
  readonly video: string;
  readonly videoWidth: number;
  readonly videoHeight: number;
};

const media = (name: string, w: number, h: number): Still => ({
  src: `/media/${name}-1280.webp`,
  srcSet: `/media/${name}-1280.webp 1280w, /media/${name}-1920.webp 1920w`,
  width: w,
  height: h,
});

/**
 * The still slots. Dimensions are the 1920-wide file's, as ffmpeg computed them
 * from each source's own aspect ratio: 1920x822 for the 21:9 hero and 1920x1080
 * for the four 16:9 section plates.
 */
export const STILLS = {
  /** index.html, behind "Four things the contracts, as written, cannot do." */
  immutability: media('immutability', 1920, 1080),
  /** how-it-works.html, behind the propose/commit/reveal/execute rail. */
  lifecycle: media('propose', 1920, 1080),
  /**
   * how-it-works.html, behind the hero. The brand set's second 21:9 frame; the
   * hero on index.html uses the first. Two pages open on the same shape and a
   * different picture, which is the point of shipping two.
   */
  howItWorks: media('hero-b', 1920, 822),
  /**
   * agents.html, behind the hero — and the one plate the mascot stands in.
   *
   * It is the Higgsfield website prototype's own Agents plate
   * (`Rwally Higgsfield/website/assets/operator-mascot-16x9.png`, 2752x1536),
   * used the way that prototype used it: the Rwally agent under a violet shaft,
   * hooded, bone-white featureless mask with one ledger rule at eye level,
   * floor-length coat, small in the frame and not gesturing. The left two
   * thirds are flat black, which is where the copy sits.
   *
   * A 1.2% edge is cropped off every side before encoding, because the frame
   * carries a bone-white panel border that `object-fit: cover` would draw as a
   * bright hairline along the top and bottom of the section.
   */
  agents: media('mascot', 1920, 1072),
  /** index.html, behind the closing section. */
  next: media('next', 1920, 1080),
} as const;

/**
 * The one moving slot. `poster` is the clip's own poster frame, so the first
 * paint and the first frame are the same picture and nothing jumps on play.
 */
export const LOOP: Motion = {
  src: '/media/loop-poster-1280.webp',
  srcSet: '/media/loop-poster-1280.webp 1280w',
  width: 1280,
  height: 720,
  video: '/media/loop-1280.mp4',
  videoWidth: 1280,
  videoHeight: 720,
};

export type StillId = keyof typeof STILLS;
