declare const PRKIT_BUILD_ID: string;

export const buildId = typeof PRKIT_BUILD_ID === "undefined" ? "development" : PRKIT_BUILD_ID;
