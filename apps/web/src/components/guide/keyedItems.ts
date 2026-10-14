export function keyedItems<T>(items: ReadonlyArray<T>, identity: (item: T) => string) {
  const occurrences = new Map<string, number>();
  return items.map((value) => {
    const id = identity(value);
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    return { key: JSON.stringify([id, occurrence]), value };
  });
}
