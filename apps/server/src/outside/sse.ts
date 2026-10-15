/** The JSON-RPC payloads of an MCP streamable HTTP answer. */
export const ssePayloads = (text: string) =>
  text.split(/\r?\n\r?\n/).map((event) =>
    event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n"),
  );
