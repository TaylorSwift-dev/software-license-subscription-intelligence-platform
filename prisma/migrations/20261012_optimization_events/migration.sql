-- Unapplied Schema Migration for LicenseIQ Optimization Events Tracking
-- Migration: 20261012_optimization_events
-- Purpose:
--   Provide persistent, auditable recording of verified optimization events 
--   (contract cancellations, seat reductions, tier downgrades) to formally verify
--   realized savings without fabricating estimates.
--
-- DO NOT RUN AGAINST PRODUCTION WITHOUT DBA REVIEW.

CREATE TABLE IF NOT EXISTS "optimization_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "softwareId" TEXT NOT NULL,
    "licenseId" TEXT,
    "eventType" TEXT NOT NULL, -- 'CANCELLATION', 'LICENSE_REDUCTION', 'TIER_DOWNGRADE', 'REALLOCATION'
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billingFrequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "previousAnnualCost" DOUBLE PRECISION NOT NULL,
    "newAnnualCost" DOUBLE PRECISION NOT NULL,
    "realizedAnnualSavings" DOUBLE PRECISION NOT NULL,
    "estimatedAnnualSavings" DOUBLE PRECISION NOT NULL,
    "verifiedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'VERIFIED', -- 'VERIFIED', 'PENDING_AUDIT', 'REVERTED'
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT "optimization_events_software_fkey" FOREIGN KEY ("softwareId") REFERENCES "software"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "optimization_events_license_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "optimization_events_softwareId_idx" ON "optimization_events"("softwareId");
CREATE INDEX IF NOT EXISTS "optimization_events_effectiveDate_idx" ON "optimization_events"("effectiveDate");
CREATE INDEX IF NOT EXISTS "optimization_events_status_idx" ON "optimization_events"("status");
