// Application-layer protection is additional to HTTPS, not a replacement for it.
// These public browser primitives contain no shared secret or human assertion.
const encoder = new TextEncoder();
export type LoginChallenge = { id: string; publicKey: JsonWebKey; expiresAt: number };
export type SealedLogin = { version: 1; id: string; publicKey: JsonWebKey; iv: string; ciphertext: string };

export function publicLoginKey(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as JsonWebKey;
  return key.kty === "EC" && key.crv === "P-256" && typeof key.x === "string" && typeof key.y === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(key.x) && /^[A-Za-z0-9_-]{43}$/.test(key.y) && key.d === undefined;
}
export function base64url(bytes: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeBase64url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
export function loginContext(id: string, origin: string) {
  return encoder.encode(`cx-query-login:v1:${origin}:${id}`);
}
export async function loginEncryptionKey(privateKey: CryptoKey, publicKey: JsonWebKey, id: string, origin: string) {
  if (!publicLoginKey(publicKey)) throw new Error("Invalid public key");
  const peer = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(id), info: loginContext(id, origin) },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealQueryLogin(challenge: LoginChallenge, account: string, password: string, origin: string): Promise<SealedLogin> {
  if (!/^[a-f0-9]{64}$/.test(challenge.id) || !publicLoginKey(challenge.publicKey) || challenge.expiresAt <= Date.now())
    throw new Error("验证已过期，请重新点击验证");
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const key = await loginEncryptionKey(pair.privateKey, challenge.publicKey, challenge.id, origin);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ account, password }));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: loginContext(challenge.id, origin), tagLength: 128 }, key, plaintext);
    return { version: 1, id: challenge.id, publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), iv: base64url(iv), ciphertext: base64url(ciphertext) };
  } finally { plaintext.fill(0); }
}
