const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  const now = Date.now();
  const timeChars: string[] = [];
  let t = now;
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ENCODING[t % 32]!;
    t = Math.floor(t / 32);
  }
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const randomChars: string[] = [];
  for (let i = 0; i < 16; i++) {
    randomChars.push(ENCODING[randomBytes[i]! % 32]!);
  }
  return timeChars.join("") + randomChars.join("");
}
