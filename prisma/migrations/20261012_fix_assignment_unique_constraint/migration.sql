-- Unapplied Migration for DBA Review
-- Migration: 20261012_fix_assignment_unique_constraint
-- Purpose: 
--   1. Resolve collision in license_assignments where @@unique([licenseId, userId, status])
--      causes a 500 UniqueConstraintViolation when an assignment is revoked, reassigned, and revoked again.
--   2. Ensure unique partial index for ACTIVE assignments only, allowing multiple historical REVOKED records.
--
-- DO NOT RUN AGAINST PRODUCTION WITHOUT DBA REVIEW AND TESTING IN STAGING.

-- Step 1: Drop existing constraint if it exists
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'license_assignments_licenseId_userId_status_key'
    ) THEN
        ALTER TABLE "license_assignments" DROP CONSTRAINT "license_assignments_licenseId_userId_status_key";
    END IF;
END $$;

-- Step 2: Create a unique partial index for ACTIVE assignments only
-- This ensures a user cannot hold duplicate ACTIVE seats on the same license concurrently,
-- while allowing audit history of past REVOKED assignments.
CREATE UNIQUE INDEX IF NOT EXISTS "license_assignments_active_user_unique" 
ON "license_assignments" ("licenseId", "userId") 
WHERE "status" = 'ACTIVE';

-- Step 3: Add index on status for faster lookup of active assignments
CREATE INDEX IF NOT EXISTS "license_assignments_status_idx" 
ON "license_assignments" ("status");
