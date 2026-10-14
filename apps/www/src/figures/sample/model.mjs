/**
 * The sample figure's truth: a dial indicator reading three gauge blocks on a sliding carriage.
 * Every number the figure shows and every motion it makes comes from here. Adapted from the
 * anatomy skill's examples/dial-indicator/build.mjs, which keeps these numbers inline.
 */

/** Gauge block heights, first to last. */
export const BLOCKS = [18, 14, 10];
/** Block pitch and width along the carriage. */
export const STEP = 16;
export const BLOCK_W = 15.6;
/** The plunger tip's radius, and where it stands along x. */
export const TIP_R = 2.6;
export const DIAL_X = 58;
/** One full turn of the needle is this much plunger travel. */
export const PER_TURN = 20;
/** The carriage's top face, which the blocks stand on. */
export const CARRIAGE_TOP = 8;
/** The first block's left edge, measured from the carriage's centre. */
export const FIRST_BLOCK = -24;

const CENTRE = FIRST_BLOCK + BLOCK_W / 2;

/** Carriage positions that put each block under the plunger. */
export const STOPS = BLOCKS.map((_, index) => DIAL_X - CENTRE - STEP * index);
/** How far the carriage may travel: a little past the outer blocks. */
export const REACH = [STOPS[STOPS.length - 1] - 6, STOPS[0] + 6];
/** Seconds the idle tour rests on each block. */
export const TOUR_STEP = 2.2;

/** Height the plunger tip rests at with the carriage at `x`: the tallest block under it. */
export const heightUnder = (x) => {
  let top = CARRIAGE_TOP;
  BLOCKS.forEach((height, index) => {
    const from = x + FIRST_BLOCK + STEP * index;
    if (from + BLOCK_W > DIAL_X - TIP_R && from < DIAL_X + TIP_R) {
      top = Math.max(top, CARRIAGE_TOP + height);
    }
  });
  return top;
};

/** The block straight under the plunger with the carriage at `x`, or -1 between blocks. */
export const blockUnder = (x) =>
  BLOCKS.findIndex((_, index) => {
    const from = x + FIRST_BLOCK + STEP * index;
    return DIAL_X >= from && DIAL_X <= from + BLOCK_W;
  });

/** The needle's reading, in turns, for a plunger tip at `tip`. */
export const turnsAt = (tip) => (tip - CARRIAGE_TOP) / PER_TURN;

/** Where the idle tour puts the carriage `seconds` after it starts. */
export const tourAt = (seconds) => STOPS[Math.floor(seconds / TOUR_STEP) % STOPS.length];
