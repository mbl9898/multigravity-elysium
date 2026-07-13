-- AddColumn: validationRequired
-- Marks accounts blocked by Google's SARP/VALIDATION_REQUIRED flow.
-- These accounts work in CLI but not in Antigravity IDE/V2.
ALTER TABLE "accounts" ADD COLUMN "validationRequired" BOOLEAN NOT NULL DEFAULT false;

-- Immediately flag the two known affected accounts
UPDATE "accounts" SET "validationRequired" = true WHERE "email" IN (
  'theman99532@gmail.com',
  'therybacks343@gmail.com'
);
