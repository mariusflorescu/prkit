/** A path under the home folder written from `~`, the way prkit's messages name directories. */
export const atHome = (path: string, home: string) =>
  path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
