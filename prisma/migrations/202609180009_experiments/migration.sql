-- Controlled email-copy experiments: stable per-enrollment assignment, human-decided recommendations.
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "primaryMetric" TEXT NOT NULL DEFAULT 'POSITIVE_REPLY',
    "minSample" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "concludedAt" TIMESTAMP(3),
    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT experiment_status CHECK ("status" IN ('DRAFT','RUNNING','STOPPED','CONCLUDED')),
    CONSTRAINT experiment_metric CHECK ("primaryMetric" IN ('POSITIVE_REPLY','BOOKED','ATTENDED')),
    CONSTRAINT experiment_limits CHECK ("stepOrder" >= 1 AND "minSample" >= 20)
);
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isControl" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT,
    "body" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "ExperimentVariant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT variant_weight CHECK ("weight" BETWEEN 1 AND 100000),
    CONSTRAINT variant_copy CHECK ("isControl" OR ("subject" IS NOT NULL AND "body" IS NOT NULL))
);
CREATE TABLE "ExperimentAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExperimentRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "verdict" JSONB NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExperimentRecommendation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT recommendation_status CHECK ("status" IN ('OPEN','ACCEPTED','REJECTED'))
);
CREATE INDEX "Experiment_tenantId_campaignId_idx" ON "Experiment"("tenantId", "campaignId");
-- At most one running experiment per campaign step, and exactly one control per experiment.
CREATE UNIQUE INDEX one_running_experiment_per_step ON "Experiment" ("campaignId", "stepOrder") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "ExperimentVariant_experimentId_label_key" ON "ExperimentVariant"("experimentId", "label");
CREATE UNIQUE INDEX one_control_per_experiment ON "ExperimentVariant" ("experimentId") WHERE "isControl";
CREATE UNIQUE INDEX "ExperimentAssignment_experimentId_enrollmentId_key" ON "ExperimentAssignment"("experimentId", "enrollmentId");
CREATE INDEX "ExperimentAssignment_variantId_idx" ON "ExperimentAssignment"("variantId");
CREATE UNIQUE INDEX "ExperimentRecommendation_experimentId_variantId_key" ON "ExperimentRecommendation"("experimentId", "variantId");

ALTER TABLE "Experiment" ADD CONSTRAINT experiment_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "Experiment" ADD CONSTRAINT experiment_campaign_fk FOREIGN KEY ("campaignId") REFERENCES "Campaign"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT variant_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT variant_experiment_fk FOREIGN KEY ("experimentId") REFERENCES "Experiment"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_experiment_fk FOREIGN KEY ("experimentId") REFERENCES "Experiment"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_variant_fk FOREIGN KEY ("variantId") REFERENCES "ExperimentVariant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT assignment_enrollment_fk FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentRecommendation" ADD CONSTRAINT recommendation_tenant_fk FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE;
ALTER TABLE "ExperimentRecommendation" ADD CONSTRAINT recommendation_experiment_fk FOREIGN KEY ("experimentId") REFERENCES "Experiment"(id) ON DELETE CASCADE;

CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "Experiment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('campaignId','Campaign');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "ExperimentVariant" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('experimentId','Experiment');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "ExperimentAssignment" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('experimentId','Experiment','variantId','ExperimentVariant','enrollmentId','Enrollment');
CREATE TRIGGER tenant_links BEFORE INSERT OR UPDATE ON "ExperimentRecommendation" FOR EACH ROW EXECUTE FUNCTION leadmelo_check_tenant_links('experimentId','Experiment');
