import * as Option from "effect/Option";
import type * as NetAddress from "effect/net/NetAddress";

export const boundPort = (address: NetAddress.SocketAddress): Option.Option<number> =>
  address._tag === "UnixPathAddress" ? Option.none() : Option.some(address.port);
