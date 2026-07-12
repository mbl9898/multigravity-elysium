-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "lastPingAt" DATETIME;
ALTER TABLE "accounts" ADD COLUMN "lastPingError" TEXT;
ALTER TABLE "accounts" ADD COLUMN "lastPingStatus" TEXT;
