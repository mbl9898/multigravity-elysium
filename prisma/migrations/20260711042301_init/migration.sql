-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "nickname" TEXT,
    "tier" TEXT,
    "projectId" TEXT,
    "encryptedRefreshToken" TEXT NOT NULL,
    "quotaJson" TEXT,
    "lastChecked" DATETIME,
    "lastError" TEXT,
    "isHealthy" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "oauth_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_sessions_state_key" ON "oauth_sessions"("state");
