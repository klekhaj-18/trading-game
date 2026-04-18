const IV_BYTES = 12;

const b64encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64decode = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function importKey(masterKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(masterKey));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  ciphertext: string;
  iv: string;
}

export async function seal(plaintext: string, masterKey: string): Promise<Sealed> {
  const key = await importKey(masterKey);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64encode(new Uint8Array(ct)), iv: b64encode(iv) };
}

export async function open(sealed: Sealed, masterKey: string): Promise<string> {
  const key = await importKey(masterKey);
  const iv = b64decode(sealed.iv);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    b64decode(sealed.ciphertext),
  );
  return new TextDecoder().decode(pt);
}

