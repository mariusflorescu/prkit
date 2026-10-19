import type { DiffComments, DiffInteraction } from "./types";

/** The comment layer of an interaction: pins, footers and counts exist only for comments. */
export const commentsOf = (interaction: DiffInteraction | undefined): DiffComments | undefined =>
  interaction?.kind === "comment" ? interaction : undefined;
