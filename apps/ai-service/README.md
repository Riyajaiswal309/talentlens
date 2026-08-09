# TalentLens AI Service

**Status: Phase 3 integration build — deterministic reference implementation.**

## What this is

The three internal endpoints PRD §23.2 reserves, so the core API's
parse-and-score pipeline can run end to end:

| Endpoint                    | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `POST /internal/ai/parse`   | resume text → structured profile + per-field confidence  |
| `POST /internal/ai/rank`    | application → composite score, feature vector, rationale |
| `POST /internal/ai/explain` | score → rationale in the §22.2 shape                     |

## What this is NOT

**There is no trained model here.** PRD §19.2 requires consent-gated
historical application data, recruiter accept/reject/hire labels, a licensed
resume corpus, a human-verified golden NER dataset, and an access-restricted
fairness dataset. None of those exist for this project, so nothing has been
trained and nothing can be evaluated against §19.6's promotion gates.

Everything is served by `app/reference_model.py`, which is:

- **not a trained ML model**
- **not production-validated**
- **not promotable under §19.6** — the fairness gate has no override path,
  and there is no fairness dataset to evaluate against
- **not evidence** of parsing, ranking or fairness performance

Its outputs are deterministic functions of the input, chosen so integration
tests can assert exact values. They are not predictions.

## Still to build (Phase 3 proper, blocked on data)

spaCy NER · pdfplumber / python-docx extraction · Tesseract OCR fallback ·
sentence-transformers embeddings · LightGBM re-ranker · SHAP attribution ·
MLflow registry · fairness auditing (§21.4)

## Run

```bash
cd apps/ai-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
curl http://localhost:8000/health
```

The core API's worker calls this service when `RESUME_WORKER_ENABLED=true`.
