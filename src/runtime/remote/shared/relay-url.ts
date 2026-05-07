export function createAcpRemoteRelayUrl(input: {
  endpointPath: string;
  params: Record<string, string>;
  relayUrl: string | URL;
}): string {
  const relayUrl = new URL(input.relayUrl);
  relayUrl.pathname = input.endpointPath;
  for (const [key, value] of Object.entries(input.params)) {
    relayUrl.searchParams.set(key, value);
  }
  return relayUrl.toString();
}
