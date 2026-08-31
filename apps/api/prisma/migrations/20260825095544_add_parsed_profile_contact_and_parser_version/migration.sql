-- AlterTable
ALTER TABLE "parsed_profiles" ADD COLUMN     "contact" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "parser_name" TEXT,
ADD COLUMN     "parser_version" TEXT;
