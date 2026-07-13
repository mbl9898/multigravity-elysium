-- AddColumn: validationRequired
-- Marks accounts blocked by Google's SARP/VALIDATION_REQUIRED flow.
-- These accounts work in CLI but not in Antigravity IDE/V2.
ALTER TABLE "accounts" ADD COLUMN "validationRequired" BOOLEAN NOT NULL DEFAULT false;

-- Immediately flag the two known affected accounts
UPDATE "accounts" SET "validationRequired" = true WHERE "email" IN (
  'REDACTED_ACCOUNT_A@example.com',
  'REDACTED_ACCOUNT_B@example.com'
);
