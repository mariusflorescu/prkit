import { ReviewSubject } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** How a subject is stored, so the reader's marks of one account never show through another. */
export const subjectKey = (subject: ReviewSubject) =>
  subject._tag === "pull-request"
    ? `pull-request ${subject.accountId} ${subject.key}`
    : `local ${subject.key}`;

const decodeSubject = Schema.decodeUnknownOption(ReviewSubject);

export const subjectFromKey = (text: string) => {
  const [kind, ...parts] = text.split(" ");
  if (kind === "pull-request" && parts.length === 2)
    return Option.getOrUndefined(decodeSubject({ _tag: kind, accountId: parts[0], key: parts[1] }));
  if (kind === "local" && parts.length === 1)
    return Option.getOrUndefined(decodeSubject({ _tag: kind, key: parts[0] }));
  return undefined;
};
