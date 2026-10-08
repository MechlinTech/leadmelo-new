-- Vendor credentials (Apollo, Hunter) managed from Settings instead of hand-editing the gateway's
-- tenants.json. The bearer token already existed as "gatewayKey"; these two complete the set so a
-- tenant can configure every provider credential from the UI.
--
-- Values are AES-256-GCM ciphertext written by lib/crypto.ts (iv.authTag.ciphertext, base64). The
-- length ceiling matches the ciphertext of a 2000-character plaintext key, and the vendor's own
-- minimum is enforced in application code so the message can be specific.
ALTER TABLE "TenantSetting"
  ADD COLUMN "apolloKey" TEXT,
  ADD COLUMN "hunterKey" TEXT;

ALTER TABLE "TenantSetting" ADD CONSTRAINT "TenantSetting_provider_key_lengths"
  CHECK (("apolloKey" IS NULL OR length("apolloKey") <= 4096) AND ("hunterKey" IS NULL OR length("hunterKey") <= 4096));
