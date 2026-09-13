-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_created_by_fkey";

-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "created_by" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
