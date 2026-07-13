-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "routingMode" TEXT NOT NULL DEFAULT 'smart',
    "lockedAccountId" TEXT,
    "customAccountIds" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- Seed the single global settings row so the app always has a row to read.
INSERT INTO "settings" ("id", "routingMode", "updatedAt")
VALUES ('global', 'smart', datetime('now'));
