/** `text` cut to `max` characters on a code point boundary, saying how many were left out. */
export const clipText = (text: string, max: number) => {
  if (text.length <= max) return text;
  const characters = Array.from(text);
  return characters.length <= max
    ? text
    : `${characters.slice(0, max).join("")} [prkit cut ${characters.length - max} more characters]`;
};
