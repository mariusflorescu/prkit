import type { ReviewSubject } from "@prkit/contracts";

/** How a subject is stored, so the reader's marks of one account never show through another. */
export const subjectKey = (subject: ReviewSubject) =>
  subject._tag === "pull-request"
    ? `pull-request ${subject.accountId} ${subject.key}`
    : `local ${subject.key}`;
