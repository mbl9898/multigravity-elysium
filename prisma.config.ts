// Prisma 7 config — connection URL lives here, not in schema.prisma
import { defineConfig } from "prisma/config";
import path from "path";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: `file:${path.resolve(process.cwd(), "prisma", "dev.db")}`,
  },
});
