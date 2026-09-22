-- Defense in depth: an API or worker defect must not link two tenants' records.
CREATE FUNCTION leadmelo_check_tenant_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i integer;
  parent_tenant text;
  parent_id text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'tenant ownership is immutable' USING ERRCODE = '23514';
  END IF;
  FOR i IN 0..(TG_NARGS / 2 - 1) LOOP
    parent_id := to_jsonb(NEW)->>TG_ARGV[i * 2];
    IF parent_id IS NOT NULL THEN
      EXECUTE format('SELECT "tenantId" FROM %I WHERE id=$1', TG_ARGV[i * 2 + 1]) INTO parent_tenant USING parent_id;
      IF parent_tenant IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'cross-tenant reference rejected' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Campaign" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('icpId','ICP');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "DiscoveryJob" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('icpId','ICP');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Contact" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('leadId','Lead');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Enrollment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign','contactId','Contact');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "AutomationRun" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "OutreachEvent" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign','contactId','Contact','leadId','Lead');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Reply" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('contactId','Contact');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Appointment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign','contactId','Contact');
ALTER TABLE "Suppression" ADD CONSTRAINT suppression_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT webhook_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT campaign_limits CHECK ("dailySendCap">0 AND "weeklyProspectCap">0 AND "minScore" BETWEEN 0 AND 100 AND "minAppointmentQualityScore" BETWEEN 0 AND 100 AND "sendStartHour">=0 AND "sendEndHour"<=24 AND "sendStartHour"<"sendEndHour");
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_interval CHECK ("scheduledEnd" IS NULL OR "scheduledStart" IS NULL OR "scheduledEnd">"scheduledStart");
ALTER TABLE "ICP" ADD CONSTRAINT icp_score CHECK ("minScore" BETWEEN 0 AND 100);
ALTER TABLE "Enrollment" ADD CONSTRAINT enrollment_score CHECK (score BETWEEN 0 AND 100);
CREATE UNIQUE INDEX one_active_enrollment_per_contact ON "Enrollment" ("tenantId", "contactId") WHERE "stoppedAt" IS NULL;
CREATE INDEX automation_due ON "AutomationRun" (status, "availableAt", "leaseUntil");
CREATE INDEX outreach_due ON "OutreachEvent" (status, "scheduledAt", "leaseUntil");
