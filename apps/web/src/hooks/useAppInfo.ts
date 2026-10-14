import { useQuery } from "@tanstack/react-query";

import { getAppInfo } from "~/rpc/client";

export const useAppInfo = () =>
  useQuery({
    queryKey: ["app", "info"],
    queryFn: getAppInfo,
    staleTime: Number.POSITIVE_INFINITY,
    // Each attempt already waits out the socket timeout; one retry is enough before showing the error.
    retry: 1,
  });
