import { randomUUID, createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, count, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db";
import { evaluation_datasets as datasets, evaluation_revisions as revisions, evaluation_experiments as experiments, evaluation_reviews as reviews } from "../db/schema";
import { canonicalCaseDefinitions, EvaluationError } from "./validation";
import { EVALUATION_LIMITS as L, type Dataset, type DatasetCase, type DatasetRevision, type Experiment, type ExperimentSummary, type Review } from "./protocol";
import { MAX_TRIAL_ACQUISITION_BYTES, parseTrialSelection } from "./trials";

export function listDatasets(): Dataset[] {
  return getDrizzleDb().select().from(datasets).orderBy(desc(datasets.created_at)).all()
    .map((row) => ({ id: row.id, name: row.name, latestVersion: row.latest_version, caseCount: row.case_count, createdAt: row.created_at }));
}

export function getRevision(id: string, version?: number): DatasetRevision {
  const db = getDrizzleDb();
  const dataset = db.select().from(datasets).where(eq(datasets.id, id)).get();
  if (!dataset) throw new EvaluationError("Dataset not found", 404);
  const row = db.select().from(revisions).where(and(eq(revisions.dataset_id, id), eq(revisions.version, version ?? dataset.latest_version))).get();
  if (!row) throw new EvaluationError("Dataset revision not found", 404);
  return { datasetId: id, datasetName: dataset.name, version: row.version, hash: row.hash,
    cases: JSON.parse(row.cases), createdAt: row.created_at };
}

export function createDataset(name: string, cases: DatasetCase[] = []): DatasetRevision {
  const id = randomUUID(), createdAt = Date.now();
  const hash = createHash("sha256").update(canonicalCaseDefinitions(cases)).digest("hex");
  getDrizzleDb().transaction((tx) => {
    if ((tx.select({ n: count() }).from(datasets).get()?.n ?? 0) >= L.MAX_DATASETS) throw new EvaluationError("Dataset limit reached", 409);
    tx.insert(datasets).values({ id, name, latest_version: 1, case_count: cases.length, created_at: createdAt }).run();
    tx.insert(revisions).values({ dataset_id: id, version: 1, hash, cases: JSON.stringify(cases), created_at: createdAt }).run();
  });
  return { datasetId: id, datasetName: name, version: 1, hash, cases, createdAt };
}

export function appendRevision(id: string, expectedVersion: number, cases: DatasetCase[]): DatasetRevision {
  return getDrizzleDb().transaction((tx) => {
    const dataset = tx.select().from(datasets).where(eq(datasets.id, id)).get();
    if (!dataset) throw new EvaluationError("Dataset not found", 404);
    if (dataset.latest_version !== expectedVersion) throw new EvaluationError("Dataset changed; reload the latest revision before saving", 409);
    if (dataset.latest_version >= L.MAX_REVISIONS) throw new EvaluationError("Dataset revision limit reached", 409);
    const version = dataset.latest_version + 1, createdAt = Date.now();
    const hash = createHash("sha256").update(canonicalCaseDefinitions(cases)).digest("hex");
    tx.insert(revisions).values({ dataset_id: id, version, hash, cases: JSON.stringify(cases), created_at: createdAt }).run();
    tx.update(datasets).set({ latest_version: version, case_count: cases.length }).where(eq(datasets.id, id)).run();
    return { datasetId: id, datasetName: dataset.name, version, hash, cases, createdAt };
  });
}

export function deleteDataset(id: string): void {
  if (!getDrizzleDb().delete(datasets).where(eq(datasets.id, id)).returning({ id: datasets.id }).get()) throw new EvaluationError("Dataset not found", 404);
}

function summarize(experiment: Experiment): ExperimentSummary {
  const { results: _results, ...summary } = experiment;
  return summary;
}
function encoded(experiment: Experiment): string {
  const data = JSON.stringify(experiment);
  if (Buffer.byteLength(data) > L.MAX_EXPERIMENT) throw new EvaluationError("Experiment exceeds the retained result size limit", 413);
  return data;
}

export function insertExperiment(experiment: Experiment, token: string): void {
  const data = encoded(experiment);
  getDrizzleDb().transaction((tx) => {
    const active = tx.select({ n: count() }).from(experiments).where(inArray(experiments.status, ["queued", "running"])).get()?.n ?? 0;
    if (active >= L.MAX_ACTIVE_JOBS) throw new EvaluationError("Two experiments are already queued or running", 409);
    const total = tx.select({ n: count() }).from(experiments).get()?.n ?? 0;
    if (total >= L.MAX_EXPERIMENTS) {
      const victims = tx.select({ id: experiments.id }).from(experiments).where(inArray(experiments.status, ["completed", "cancelled"]))
        .orderBy(asc(experiments.created_at)).limit(total - L.MAX_EXPERIMENTS + 1).all();
      if (victims.length < total - L.MAX_EXPERIMENTS + 1) throw new EvaluationError("Experiment retention is full", 409);
      tx.delete(experiments).where(inArray(experiments.id, victims.map((row) => row.id))).run();
    }
    tx.insert(experiments).values({ id: experiment.id, status: experiment.status, job_token: token, completed_checks: 0,
      data, summary: JSON.stringify(summarize(experiment)), created_at: experiment.createdAt, completed_at: null }).run();
  });
}

export function getExperimentRecord(id: string) {
  const row = getDrizzleDb().select().from(experiments).where(eq(experiments.id, id)).get();
  if (!row) throw new EvaluationError("Experiment not found", 404);
  return { experiment: JSON.parse(row.data) as Experiment, token: row.job_token, completedChecks: row.completed_checks };
}
export function getExperiment(id: string): Experiment { return getExperimentRecord(id).experiment; }
export function readExperimentSelection(ids: string[], consume: (experiment: Experiment) => void): void {
  parseTrialSelection({ experimentIds: ids });
  getDrizzleDb().transaction(tx => {
    const bound = tx.select({ count: count(), bytes: sql<number>`coalesce(sum(length(cast(${experiments.data} as blob))), 0)` })
      .from(experiments).where(inArray(experiments.id, ids)).get()!;
    if (bound.count !== ids.length) throw new EvaluationError("Experiment not found", 404);
    if (bound.bytes > MAX_TRIAL_ACQUISITION_BYTES) throw new EvaluationError("Selected experiment evidence exceeds 8 MiB", 413);
    for (const id of ids) {
      const row = tx.select({ data: experiments.data }).from(experiments).where(eq(experiments.id, id)).get()!;
      consume(JSON.parse(row.data) as Experiment);
    }
  });
}
export function listExperiments(): ExperimentSummary[] {
  return getDrizzleDb().select({ summary: experiments.summary }).from(experiments).orderBy(desc(experiments.created_at)).limit(50).all()
    .map((row) => JSON.parse(row.summary));
}
export function activeExperiments() {
  return getDrizzleDb().select({ id: experiments.id }).from(experiments).where(inArray(experiments.status, ["queued", "running"])).all();
}

/** All progress and terminal writes compare the job token and require a nonterminal row. */
export function updateExperiment(experiment: Experiment, token: string, completedChecks: number): boolean {
  const data = encoded(experiment);
  return getDrizzleDb().update(experiments).set({ data, summary: JSON.stringify(summarize(experiment)), status: experiment.status,
    completed_checks: completedChecks, completed_at: experiment.completedAt })
    .where(and(eq(experiments.id, experiment.id), eq(experiments.job_token, token), inArray(experiments.status, ["queued", "running"])))
    .returning({ id: experiments.id }).all().length === 1;
}

export function listReviews(experimentId: string): Review[] {
  getExperiment(experimentId);
  return getDrizzleDb().select().from(reviews).where(eq(reviews.experiment_id, experimentId)).orderBy(desc(reviews.created_at), desc(reviews.id)).all()
    .map((row) => ({ id: row.id, experimentId: row.experiment_id, caseId: row.case_id, rating: row.rating as Review["rating"], note: row.note, createdAt: row.created_at }));
}
export function addReview(experimentId: string, draft: { caseId: string; rating: Review["rating"]; note: string }): Review {
  const experiment = getExperiment(experimentId);
  if (!experiment.results.some((result) => result.caseId === draft.caseId)) throw new EvaluationError("Review case is not part of this experiment", 400);
  return getDrizzleDb().transaction((tx) => {
    const previous = tx.select({ createdAt: reviews.created_at }).from(reviews).orderBy(desc(reviews.created_at)).limit(1).get();
    const review: Review = { id: randomUUID(), experimentId, ...draft, createdAt: Math.max(Date.now(), (previous?.createdAt ?? 0) + 1) };
    tx.insert(reviews).values({ id: review.id, experiment_id: experimentId, case_id: review.caseId, rating: review.rating, note: review.note, created_at: review.createdAt }).run();
    const old = tx.select({ id: reviews.id }).from(reviews).orderBy(desc(reviews.created_at), desc(reviews.id)).limit(L.MAX_REVIEWS).offset(L.MAX_REVIEWS).all();
    if (old.length) tx.delete(reviews).where(inArray(reviews.id, old.map((row) => row.id))).run();
    return review;
  });
}
