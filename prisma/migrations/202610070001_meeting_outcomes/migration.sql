CREATE TYPE "MeetingOutcome" AS ENUM ('COMPLETED', 'NO_SHOW', 'DISQUALIFIED', 'WON', 'LOST');

ALTER TABLE "Appointment" ADD COLUMN "outcome" "MeetingOutcome";

UPDATE "Appointment"
SET "outcome" = ("status"::text)::"MeetingOutcome"
WHERE "status"::text IN ('COMPLETED', 'NO_SHOW', 'DISQUALIFIED', 'WON', 'LOST');

UPDATE "Appointment"
SET "status" = 'BOOKED'
WHERE "outcome" IS NOT NULL;