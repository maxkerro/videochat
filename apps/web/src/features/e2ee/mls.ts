import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processPrivateMessage,
  type CiphersuiteImpl,
  type ClientConfig,
  type ClientState,
  type KeyPackage,
  type PrivateKeyPackage,
} from 'ts-mls';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { E2EE } from '@videochat/shared';

/**
 * CHAT-076 (spike): a thin wrapper over ts-mls, so the rest of the app deals in bytes and base64
 * and never in MLS structures. One cipher suite for every device (`E2EE.cipherSuite`).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
export const fromBase64 = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDENTITY = new RegExp(`^(${UUID}):(${UUID})$`, 'i');

/** A device's MLS identity: `userId:deviceId`. */
export const identityFor = (userId: string, deviceId: string) =>
  enc.encode(`${userId}:${deviceId}`);
export function parseIdentity(identity: Uint8Array): { userId: string; deviceId: string } | null {
  const m = IDENTITY.exec(dec.decode(identity));
  return m ? { userId: m[1]!.toLowerCase(), deviceId: m[2]!.toLowerCase() } : null;
}

/** Only accepts basic credentials that name a device in our `userId:deviceId` form. */
const clientConfig: ClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: {
    validateCredential: async (credential) =>
      credential.credentialType === 'basic' && parseIdentity(credential.identity) !== null,
  },
};

let suite: Promise<CiphersuiteImpl> | undefined;
export const cipherSuite = () =>
  (suite ??= getCiphersuiteImpl(getCiphersuiteFromName(E2EE.cipherSuite)));

export interface GeneratedKeyPackage {
  ref: string;
  publicBytes: Uint8Array;
  privateKeys: PrivateKeyPackage;
}

export async function newKeyPackage(identity: Uint8Array): Promise<GeneratedKeyPackage> {
  const cs = await cipherSuite();
  const kp = await generateKeyPackage(
    { credentialType: 'basic', identity },
    defaultCapabilities(),
    defaultLifetime,
    [],
    cs,
  );
  return {
    ref: toHex(await makeKeyPackageRef(kp.publicPackage, cs.hash)),
    publicBytes: encodeMlsMessage({
      version: 'mls10',
      wireformat: 'mls_key_package',
      keyPackage: kp.publicPackage,
    }),
    privateKeys: kp.privatePackage,
  };
}

function decodeKeyPackage(bytes: Uint8Array): KeyPackage {
  const msg = decodeMlsMessage(bytes, 0)?.[0];
  if (!msg || msg.wireformat !== 'mls_key_package') throw new Error('Not a key package');
  return msg.keyPackage;
}

export function keyPackageIdentity(bytes: Uint8Array): Uint8Array {
  const leaf = decodeKeyPackage(bytes).leafNode;
  if (leaf.credential.credentialType !== 'basic') throw new Error('Unsupported credential');
  return leaf.credential.identity;
}

export const encodeState = (state: ClientState) => encodeGroupState(state);
export function decodeState(bytes: Uint8Array): ClientState {
  const decoded = decodeGroupState(bytes, 0)?.[0];
  if (!decoded) throw new Error('Corrupt group state');
  return { ...decoded, clientConfig };
}

/** Creates the conversation's group with the creator's key package, adds every claimed device
 *  in one commit, and returns the state plus one Welcome (the same bytes go to every device). */
export async function createGroupWith(
  groupId: string,
  own: GeneratedKeyPackage,
  others: Uint8Array[],
): Promise<{ state: ClientState; welcome: Uint8Array | null }> {
  const cs = await cipherSuite();
  const created = await createGroup(
    enc.encode(groupId),
    decodeKeyPackage(own.publicBytes),
    own.privateKeys,
    [],
    cs,
    clientConfig,
  );
  if (others.length === 0) return { state: created, welcome: null };
  const commit = await createCommit(
    { state: created, cipherSuite: cs },
    {
      extraProposals: others.map((bytes) => ({
        proposalType: 'add' as const,
        add: { keyPackage: decodeKeyPackage(bytes) },
      })),
      // The tree travels inside the Welcome, so joiners need nothing else from the server.
      ratchetTreeExtension: true,
    },
  );
  if (!commit.welcome) throw new Error('No welcome produced');
  return {
    state: commit.newState,
    welcome: encodeMlsMessage({
      version: 'mls10',
      wireformat: 'mls_welcome',
      welcome: commit.welcome,
    }),
  };
}

/** The KeyPackageRefs (hex) a Welcome was made for. */
export function welcomeRefs(bytes: Uint8Array): string[] {
  const msg = decodeMlsMessage(bytes, 0)?.[0];
  if (!msg || msg.wireformat !== 'mls_welcome') throw new Error('Not a welcome');
  return msg.welcome.secrets.map((s) => toHex(s.newMember));
}

export async function joinWithWelcome(
  bytes: Uint8Array,
  own: { publicBytes: Uint8Array; privateKeys: PrivateKeyPackage },
): Promise<{ state: ClientState; groupId: string }> {
  const msg = decodeMlsMessage(bytes, 0)?.[0];
  if (!msg || msg.wireformat !== 'mls_welcome') throw new Error('Not a welcome');
  const cs = await cipherSuite();
  const state = await joinGroup(
    msg.welcome,
    decodeKeyPackage(own.publicBytes),
    own.privateKeys,
    emptyPskIndex,
    cs,
    undefined,
    undefined,
    clientConfig,
  );
  return { state, groupId: dec.decode(state.groupContext.groupId) };
}

/** The identities (`userId:deviceId`) of everyone in the group, for verification UI and checks. */
export function groupMembers(state: ClientState): { userId: string; deviceId: string }[] {
  const out: { userId: string; deviceId: string }[] = [];
  for (const node of state.ratchetTree) {
    if (node?.nodeType === 'leaf' && node.leaf.credential.credentialType === 'basic') {
      const id = parseIdentity(node.leaf.credential.identity);
      if (id) out.push(id);
    }
  }
  return out;
}

export async function encryptText(state: ClientState, text: string) {
  const cs = await cipherSuite();
  const res = await createApplicationMessage(state, enc.encode(text), cs);
  return {
    state: res.newState,
    ciphertext: encodeMlsMessage({
      version: 'mls10',
      wireformat: 'mls_private_message',
      privateMessage: res.privateMessage,
    }),
  };
}

export async function decryptText(state: ClientState, ciphertext: Uint8Array) {
  const msg = decodeMlsMessage(ciphertext, 0)?.[0];
  if (!msg || msg.wireformat !== 'mls_private_message') throw new Error('Not an MLS message');
  const cs = await cipherSuite();
  const res = await processPrivateMessage(state, msg.privateMessage, emptyPskIndex, cs);
  if (res.kind !== 'applicationMessage') {
    return { state: res.newState, text: null };
  }
  return { state: res.newState, text: dec.decode(res.message) };
}
