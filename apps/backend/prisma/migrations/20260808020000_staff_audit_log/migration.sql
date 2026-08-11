-- CreateTable
CREATE TABLE "StaffAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actionType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffAuditLog_createdAt_idx" ON "StaffAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "StaffAuditLog_targetType_targetId_idx" ON "StaffAuditLog"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "StaffAuditLog" ADD CONSTRAINT "StaffAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
