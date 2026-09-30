CREATE TABLE "private_image_deletions" (
	"object_key" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"storage_deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "private_image_deletions_cleanup_idx" ON "private_image_deletions" USING btree ("requested_at","last_attempt_at","storage_deleted_at");
--> statement-breakpoint
ALTER TABLE "private_image_deletions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "private_image_deletions" FROM anon, authenticated;
