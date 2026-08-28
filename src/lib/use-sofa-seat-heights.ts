// ---------------------------------------------------------------------------
// useSofaSeatHeights — the Maintenance seat-height list, for any screen.
//
// One line per consumer, deliberately: the reason eight copies of this list
// drifted apart is that following the config USED to mean writing the same
// twenty lines of cache-read / fetch / subscribe in every file, and a hardcoded
// array is quicker every single time. Make the right thing the short thing.
//
// See `sofa-seat-heights.ts` for the rule itself and the history.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import {
  VARIANTS_CONFIG_KEY,
  getVariantsConfigSync,
  fetchVariantsConfig,
  subscribeKvConfig,
} from "./kv-config";
import { sofaSeatHeights, type SofaSizesConfigLike } from "./sofa-seat-heights";

/**
 * Seat heights from Maintenance → Sofa → Sizes, live.
 *
 * Renders immediately from the shared cache (no flash of defaults when moving
 * between pages), refreshes from the server, and follows edits made in another
 * tab or on the Maintenance screen itself.
 */
export function useSofaSeatHeights(): string[] {
  const [heights, setHeights] = useState<string[]>(() =>
    sofaSeatHeights(getVariantsConfigSync() as SofaSizesConfigLike | null),
  );

  useEffect(() => {
    let cancelled = false;

    void fetchVariantsConfig().then((v) => {
      if (!cancelled) setHeights(sofaSeatHeights(v as SofaSizesConfigLike | null));
    });

    // Maintenance writes the blob from another page; without this the operator
    // adds a size and has to reload to see it, which is the same "nothing
    // happened" they reported in the first place.
    const off = subscribeKvConfig(VARIANTS_CONFIG_KEY, (value) => {
      setHeights(sofaSeatHeights(value as SofaSizesConfigLike | null));
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return heights;
}
