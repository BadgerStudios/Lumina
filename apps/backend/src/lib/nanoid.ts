import { customAlphabet } from "nanoid";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

export const generateInviteCode = customAlphabet(ALPHABET, 8);
