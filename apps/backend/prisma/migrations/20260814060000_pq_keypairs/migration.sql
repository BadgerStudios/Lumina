-- Rotating hybrid post-quantum KEM keypairs (X25519 + ML-KEM-768). Additive only.
CREATE TABLE "PqKeypair" (
    "kid" TEXT NOT NULL,
    "x25519Pub" BYTEA NOT NULL,
    "x25519Priv" BYTEA NOT NULL,
    "mlkemPub" BYTEA NOT NULL,
    "mlkemPriv" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    CONSTRAINT "PqKeypair_pkey" PRIMARY KEY ("kid")
);
