import { LocalReviewKey } from "@prkit/contracts";
import { getRouteApi } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { LocalReviewGone } from "~/features/localReviews/LocalReviewGone";
import { LocalReviewScreen } from "~/features/localReviews/LocalReviewScreen";

const route = getRouteApi("/local/$key");
const decodeKey = Schema.decodeUnknownOption(LocalReviewKey);

/** A guide of local changes; a key that names none reads as removed. */
export function LocalReviewPage() {
  const key = Option.getOrNull(decodeKey(route.useParams().key));
  if (key === null) return <LocalReviewGone />;
  return <LocalReviewScreen key={key} reviewKey={key} />;
}
