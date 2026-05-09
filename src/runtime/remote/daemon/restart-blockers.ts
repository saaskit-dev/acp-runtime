import {
  countAcpRemoteDaemonInFlightRuntimeRequests,
  type AcpRemoteDaemonConnectionState,
} from "./relay-connection.js";

export type AcpRemoteDaemonRestartBlockers = {
  activeConnections: number;
  inFlightRuntimeRequests: number;
};

export function readDaemonRestartBlockers(
  state: AcpRemoteDaemonConnectionState,
): AcpRemoteDaemonRestartBlockers {
  return {
    activeConnections: state.active.size,
    inFlightRuntimeRequests:
      countAcpRemoteDaemonInFlightRuntimeRequests(state),
  };
}

export function hasDaemonRestartBlockers(
  blockers: AcpRemoteDaemonRestartBlockers,
): boolean {
  return blockers.inFlightRuntimeRequests > 0;
}
