import express, { type Request, type Response, type NextFunction } from "express";
import type { EvaluationService } from "./service";
import { parseId, parseVersion, EvaluationError } from "./validation";
import { loadSnapshot, listResponseSpans } from "./loader";
import * as store from "./store";
import { redactText } from "../verification/serialization";
import { createEvaluationReport, evaluationReportJUnit } from "./report";
import { analyzeTrials, parseTrialSelection } from "./trials";

function version(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new EvaluationError("version must be a positive integer");
  return parseVersion(Number(value));
}
export function createEvaluationRouter(service: EvaluationService): express.Router {
  const router = express.Router();
  const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
  router.get("/datasets", route((_req, res) => res.json(store.listDatasets())));
  router.post("/datasets", route((req, res) => res.status(201).json(service.createDataset(req.body))));
  router.post("/datasets/import", route((req, res) => res.status(201).json(service.importDataset(req.body))));
  router.get("/datasets/:id/export", route((req, res) => res.json(service.exportDataset(parseId(req.params.id), version(req.query.version)))));
  router.get("/datasets/:id", route((req, res) => res.json(store.getRevision(parseId(req.params.id), version(req.query.version)))));
  router.put("/datasets/:id", route((req, res) => res.status(201).json(service.updateDataset(parseId(req.params.id), req.body))));
  router.delete("/datasets/:id", route((req, res) => { store.deleteDataset(parseId(req.params.id)); res.status(204).end(); }));
  router.get("/runs/:id/snapshot", route((req, res) => res.json(loadSnapshot(parseId(req.params.id), req.query.outputSpanId === undefined ? undefined : parseId(req.query.outputSpanId)))));
  router.get("/runs/:id/response-spans", route((req, res) => res.json(listResponseSpans(parseId(req.params.id)))));
  router.get("/experiments", route((_req, res) => res.json(store.listExperiments())));
  router.post("/analyses/repeated-trials", route((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(analyzeTrials(parseTrialSelection(req.body), store.readExperimentSelection));
  }));
  router.post("/experiments", route((req, res) => res.status(202).json(service.start(req.body))));
  router.get("/compare", route((req, res) => res.json(service.compare(parseId(req.query.baseline), parseId(req.query.candidate)))));
  router.get("/experiments/:id", route((req, res) => res.json(service.getExperiment(parseId(req.params.id)))));
  router.get("/experiments/:id/report", route((req, res) => {
    const format = req.query.format ?? "json";
    if (format !== "json" && format !== "junit") throw new EvaluationError("format must be json or junit");
    const id = parseId(req.params.id);
    const comparison = req.query.baseline === undefined ? undefined : service.compare(parseId(req.query.baseline), id);
    const report = createEvaluationReport(service.getExperiment(id), comparison);
    res.setHeader("Cache-Control", "no-store");
    if (format === "junit") res.type("application/xml").send(evaluationReportJUnit(report));
    else res.json(report);
  }));
  router.post("/experiments/:id/cancel", route((req, res) => res.json(service.cancel(parseId(req.params.id)))));
  router.get("/experiments/:id/reviews", route((req, res) => res.json(store.listReviews(parseId(req.params.id)))));
  router.post("/experiments/:id/reviews", route((req, res) => res.status(201).json(service.addReview(parseId(req.params.id), req.body))));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const expected = error instanceof EvaluationError;
    res.status(expected ? error.status : 500).json({ error: expected ? redactText(error.message) : "Evaluation request failed" });
  });
  return router;
}
