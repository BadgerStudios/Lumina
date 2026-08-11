import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  return verify(hashValue, password);
}
