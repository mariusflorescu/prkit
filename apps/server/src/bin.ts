// `mcp-bridge` is what an outside agent's client runs on every start (outside/bridge.ts). It
// loads only the bridge, before the server's CLI and layer graph, so it starts fast.
if (process.argv[2] === "mcp-bridge") {
  const { main } = await import("./outside/bridge.ts");
  await main();
} else {
  await import("./cli.ts");
}
