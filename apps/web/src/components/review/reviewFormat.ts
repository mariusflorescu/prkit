/** "under a minute", "about 3 min": coarse, because it is a typical time, not a promise. */
export const formatTypical = (seconds: number) =>
  seconds < 60 ? "under a minute" : `about ${Math.round(seconds / 60)} min`;

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);
