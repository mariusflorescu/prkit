const mounts: Array<() => void> = [];
let idleHandle: number | undefined;

function runNextMount() {
  idleHandle = undefined;
  mounts.shift()?.();
  if (mounts.length) idleHandle = window.requestIdleCallback(runNextMount, { timeout: 3000 });
}

export function queueIdleMount(mount: () => void) {
  mounts.push(mount);
  if (idleHandle === undefined)
    idleHandle = window.requestIdleCallback(runNextMount, { timeout: 3000 });
  return () => {
    const index = mounts.indexOf(mount);
    if (index !== -1) mounts.splice(index, 1);
    if (mounts.length === 0 && idleHandle !== undefined) {
      window.cancelIdleCallback(idleHandle);
      idleHandle = undefined;
    }
  };
}
