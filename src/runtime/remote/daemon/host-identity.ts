import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { emitRuntimeSuppressedError } from "../../observability/logging.js";
import { resolveRuntimeHomePath } from "../../paths.js";

export const ACP_REMOTE_DAEMON_IDENTITY_VERSION = 1 as const;

export type AcpRemoteDaemonIdentity = {
  createdAt: string;
  previousPublicKey?: string;
  privateKeyPkcs8: string;
  publicKey: string;
  updatedAt: string;
  version: typeof ACP_REMOTE_DAEMON_IDENTITY_VERSION;
};

export type AcpRemoteDaemonMachineIdentity = {
  daemonId: string;
  identity: AcpRemoteDaemonIdentity;
  machine: string;
};

export type AcpRemoteDaemonIdentityRecord = {
  previousPublicKey?: string;
  publicKey: string;
};

export type AcpRemoteDaemonHostRegistrationRecord =
  AcpRemoteDaemonIdentityRecord & {
    accountId: string;
    daemonId: string;
  };

type AcpRemoteDaemonPrivateKey = Awaited<
  ReturnType<typeof crypto.subtle.importKey>
>;

export async function createAcpRemoteDaemonIdentity(
  now: Date = new Date(),
): Promise<AcpRemoteDaemonIdentity> {
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as {
    privateKey: AcpRemoteDaemonPrivateKey;
    publicKey: AcpRemoteDaemonPrivateKey;
  };
  const [privateKeyPkcs8, publicKey] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    crypto.subtle.exportKey("raw", keyPair.publicKey),
  ]);
  const timestamp = now.toISOString();
  return {
    createdAt: timestamp,
    privateKeyPkcs8: bytesToBase64Url(new Uint8Array(privateKeyPkcs8)),
    publicKey: bytesToBase64Url(new Uint8Array(publicKey)),
    updatedAt: timestamp,
    version: ACP_REMOTE_DAEMON_IDENTITY_VERSION,
  };
}

export async function loadAcpRemoteDaemonIdentity(
  path: string,
): Promise<AcpRemoteDaemonIdentity | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return parseAcpRemoteDaemonIdentity(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function loadOrCreateAcpRemoteDaemonIdentity(input: {
  now?: Date;
  path?: string;
  accountId: string;
  daemonId: string;
}): Promise<AcpRemoteDaemonIdentity> {
  const path =
    input.path ??
    resolveAcpRemoteDaemonIdentityPath(input.accountId, input.daemonId);
  const existing = await loadAcpRemoteDaemonIdentity(path);
  if (existing) {
    return existing;
  }
  const identity = await createAcpRemoteDaemonIdentity(input.now);
  await saveAcpRemoteDaemonIdentity(path, identity);
  return identity;
}

export async function rotateAcpRemoteDaemonIdentity(input: {
  now?: Date;
  path?: string;
  accountId: string;
  daemonId: string;
}): Promise<AcpRemoteDaemonIdentity> {
  const path =
    input.path ??
    resolveAcpRemoteDaemonIdentityPath(input.accountId, input.daemonId);
  const existing = await loadAcpRemoteDaemonIdentity(path);
  const next = await createAcpRemoteDaemonIdentity(input.now);
  const identity: AcpRemoteDaemonIdentity = {
    ...next,
    createdAt: existing?.createdAt ?? next.createdAt,
    previousPublicKey: existing?.publicKey,
  };
  await saveAcpRemoteDaemonIdentity(path, identity);
  return identity;
}

export async function saveAcpRemoteDaemonIdentity(
  path: string,
  identity: AcpRemoteDaemonIdentity,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export async function loadOrCreateDaemonMachineIdentity(): Promise<AcpRemoteDaemonMachineIdentity> {
  const path = resolveRuntimeHomePath("daemon", "identity.json");
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    if (data.daemonId && data.machine === hostname()) {
      const identity = parseAcpRemoteDaemonIdentity(data.identity);
      return { daemonId: data.daemonId, identity, machine: data.machine };
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      emitRuntimeSuppressedError({
        attributes: {
          "acp.remote.daemon.identity_path": path,
        },
        body: "Daemon machine identity could not be loaded; creating a new identity.",
        eventName: "acp.remote.daemon.identity.load.failed",
        exception: error,
      });
    }
  }

  const daemonId = crypto.randomUUID();
  const identity = await createAcpRemoteDaemonIdentity();
  const machine = hostname();
  const record: AcpRemoteDaemonMachineIdentity = { daemonId, identity, machine };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function createAcpRemoteDaemonIdentityRecord(
  identity: AcpRemoteDaemonIdentity,
): AcpRemoteDaemonIdentityRecord {
  return {
    previousPublicKey: identity.previousPublicKey,
    publicKey: identity.publicKey,
  };
}

export function createAcpRemoteDaemonHostRegistrationRecord(input: {
  accountId: string;
  daemonId: string;
  identity: AcpRemoteDaemonIdentity;
}): AcpRemoteDaemonHostRegistrationRecord {
  return {
    accountId: input.accountId,
    daemonId: input.daemonId,
    ...createAcpRemoteDaemonIdentityRecord(input.identity),
  };
}

export function resolveAcpRemoteDaemonIdentityPath(
  accountId: string,
  daemonId: string,
): string {
  return resolveRuntimeHomePath(
    "remote",
    "hosts",
    encodeURIComponent(accountId),
    `${encodeURIComponent(daemonId)}.json`,
  );
}

export async function createAcpRemoteDaemonRegistrationHeaders(input: {
  now?: Date;
  nonce?: string;
  accountId: string;
  daemonId: string;
  identity: AcpRemoteDaemonIdentity;
}): Promise<Record<string, string>> {
  const timestamp = String(input.now?.getTime() ?? Date.now());
  const nonce = input.nonce ?? crypto.randomUUID();
  const privateKey = await importAcpRemoteDaemonPrivateKey(
    input.identity.privateKeyPkcs8,
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    toArrayBuffer(
      new TextEncoder().encode(
        daemonRegistrationPayload({
          accountId: input.accountId,
          daemonId: input.daemonId,
          nonce,
          timestamp,
        }),
      ),
    ),
  );
  return {
    "x-acp-account-id": input.accountId,
    "x-acp-daemon-public-key": input.identity.publicKey,
    "x-acp-daemon-nonce": nonce,
    "x-acp-daemon-signature": bytesToBase64Url(new Uint8Array(signature)),
    "x-acp-daemon-timestamp": timestamp,
    "x-acp-daemon-id": input.daemonId,
  };
}

async function importAcpRemoteDaemonPrivateKey(
  privateKeyPkcs8: string,
): Promise<AcpRemoteDaemonPrivateKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(base64UrlToBytes(privateKeyPkcs8)),
    "Ed25519",
    false,
    ["sign"],
  );
}

function daemonRegistrationPayload(input: {
  accountId: string;
  daemonId: string;
  nonce: string;
  timestamp: string;
}): string {
  return [
    input.accountId,
    input.daemonId,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

function parseAcpRemoteDaemonIdentity(
  value: unknown,
): AcpRemoteDaemonIdentity {
  if (!isRecord(value)) {
    throw new Error("ACP remote daemon identity must be an object.");
  }
  if (value.version !== ACP_REMOTE_DAEMON_IDENTITY_VERSION) {
    throw new Error("Unsupported ACP remote daemon identity version.");
  }
  if (
    typeof value.createdAt !== "string" ||
    typeof value.privateKeyPkcs8 !== "string" ||
    typeof value.publicKey !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("ACP remote daemon identity is malformed.");
  }
  return {
    createdAt: value.createdAt,
    previousPublicKey:
      typeof value.previousPublicKey === "string"
        ? value.previousPublicKey
        : undefined,
    privateKeyPkcs8: value.privateKeyPkcs8,
    publicKey: value.publicKey,
    updatedAt: value.updatedAt,
    version: ACP_REMOTE_DAEMON_IDENTITY_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}
