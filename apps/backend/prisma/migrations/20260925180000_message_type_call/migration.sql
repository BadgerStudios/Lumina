-- A missed or declined DM call, posted into the conversation (realtime/callRing.ts).
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'CALL';
