-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "reverifyRequestedAt" TIMESTAMP(3),
ADD COLUMN     "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "verificationNextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "OutreachEvent" ADD COLUMN     "leaseToken" TEXT;

-- CreateTable
CREATE TABLE "M365Connection" (
    "tenantId" TEXT NOT NULL,
    "directoryId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "mailboxes" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "M365Connection_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "MailReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "draftId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "sentConfirmedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailCursor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "cursor" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "MailCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "OperationalAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "M365Connection_directoryId_key" ON "M365Connection"("directoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MailReceipt_key_key" ON "MailReceipt"("key");

-- CreateIndex
CREATE INDEX "MailReceipt_tenantId_status_idx" ON "MailReceipt"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MailReceipt_tenantId_mailbox_internetMessageId_idx" ON "MailReceipt"("tenantId", "mailbox", "internetMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "MailCursor_tenantId_mailbox_key" ON "MailCursor"("tenantId", "mailbox");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalAlert_key_key" ON "OperationalAlert"("key");

-- CreateIndex
CREATE INDEX "OperationalAlert_tenantId_createdAt_idx" ON "OperationalAlert"("tenantId", "createdAt");

ALTER TABLE "M365Connection" ADD CONSTRAINT m365_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "MailReceipt" ADD CONSTRAINT mail_receipt_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "MailCursor" ADD CONSTRAINT mail_cursor_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "OperationalAlert" ADD CONSTRAINT alert_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "MailReceipt" ADD CONSTRAINT mail_receipt_status CHECK (status IN ('NEW','CREATING','DRAFT','SUBMITTING','ACCEPTED','AMBIGUOUS'));
CREATE INDEX reverify_due ON "Contact" ("verificationNextAt") WHERE "reverifyRequestedAt" IS NOT NULL;
CREATE INDEX alert_due ON "OperationalAlert" ("nextAttemptAt") WHERE "deliveredAt" IS NULL AND "acknowledgedAt" IS NULL;
