// Pure and dependency-free: the server serves this module to the browser unchanged, like money.ts.

/** Picker order: a cool row (sky to forest), then a warm row (lime to plum). Ties in leastUsedColour follow it. */
export const BUCKET_COLOURS = [
  "sky", "denim", "blue", "slate", "teal", "mint", "green", "forest",
  "lime", "olive", "sun", "cocoa", "peach", "tangerine", "rose", "plum",
] as const;

export type BucketColour = (typeof BUCKET_COLOURS)[number];

export function isBucketColour(value: unknown): value is BucketColour {
  return (BUCKET_COLOURS as readonly unknown[]).includes(value);
}

/** The default colour for a new bucket: the least used among the given (active) buckets, ties in palette order. */
export function leastUsedColour(activeBuckets: readonly { colour: string }[]): BucketColour {
  const counts = new Map<string, number>();
  for (const bucket of activeBuckets) counts.set(bucket.colour, (counts.get(bucket.colour) ?? 0) + 1);
  let best: BucketColour = BUCKET_COLOURS[0];
  for (const colour of BUCKET_COLOURS) {
    if ((counts.get(colour) ?? 0) < (counts.get(best) ?? 0)) best = colour;
  }
  return best;
}
