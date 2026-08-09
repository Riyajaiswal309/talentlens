"""TalentLens AI Service — Phase 3 integration build.

WHAT THIS SERVICE IS

It implements the three internal endpoints PRD §23.2 reserves, so the core
API's parse-and-score pipeline can be exercised end to end:

    POST /internal/ai/parse    resume text -> structured profile
    POST /internal/ai/rank     application -> composite score + rationale
    POST /internal/ai/explain  score -> rationale (§22.2 shape)

WHAT THIS SERVICE IS NOT

There is no trained model behind any of them. PRD §19.2 requires
consent-gated historical application data, recruiter accept/reject/hire
labels, a licensed resume corpus, a human-verified golden NER dataset, and an
access-restricted fairness dataset. None exists, so nothing has been trained
and nothing could be evaluated against §19.6's gates.

Everything is served by `reference_model`, a deterministic stand-in. It is:

    * not a trained ML model
    * not production-validated
    * not promotable under §19.6 — the fairness gate has no override path
    * not evidence of parsing, ranking or fairness performance

Still absent, and still Phase 3 proper: spaCy NER, pdfplumber/python-docx
extraction, Tesseract OCR fallback, sentence-transformers embeddings, the
LightGBM re-ranker, SHAP attribution, MLflow, and the fairness audit.

BINDING CONSTRAINTS honoured here (PRD §13)
    BR-02  /rank never returns a score without a rationale
    BR-07  the feature vector is restricted to the Table 19.1 allow-list
    BR-01  nothing here can transition an application's stage
"""

from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app import reference_model

app = FastAPI(
    title="TalentLens AI Service",
    version="0.3.0",
    description=(
        "Phase 3 integration build. Serves a DETERMINISTIC REFERENCE "
        "IMPLEMENTATION, not a trained model: no corpus, hiring labels, "
        "golden dataset or fairness dataset exist (PRD §19.2), so nothing "
        "here is validated or promotable under §19.6."
    ),
)


class ParseRequest(BaseModel):
    resumeId: str
    text: str = ""


class RankRequest(BaseModel):
    applicationId: str
    profile: dict[str, Any] = Field(default_factory=dict)
    weights: dict[str, float] = Field(default_factory=dict)


class ExplainRequest(BaseModel):
    applicationId: str
    featureVector: dict[str, float] = Field(default_factory=dict)
    weights: dict[str, float] = Field(default_factory=dict)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "ai-service",
        "phase": 3,
        "model": "reference-stub (NOT TRAINED, NOT VALIDATED)",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/internal/ai/parse")
def parse(request: ParseRequest) -> dict[str, Any]:
    """§20 stages 2-7. Keyword extraction, not NER.

    Returns a per-field confidence map; anything below 0.75 is flagged for
    human review by the caller rather than accepted (FR3.2, §20 stage 5).
    """
    return reference_model.parse(request.resumeId, request.text)


@app.post("/internal/ai/rank")
def rank(request: RankRequest) -> dict[str, Any]:
    """§21 scoring. Always returns a rationale — BR-02 has no exception."""
    return reference_model.rank(request.applicationId, request.profile, request.weights)


@app.post("/internal/ai/explain")
def explain(request: ExplainRequest) -> dict[str, Any]:
    """§22 attribution, in the documented shape. NOT SHAP.

    Kept as its own endpoint because §23.2 reserves it and the core API may
    call it independently; /rank already embeds the same rationale, since
    BR-02 forbids returning a score without one.
    """
    scored = reference_model.rank(request.applicationId, {}, request.weights)
    return {"rationale": scored["rationale"], "modelVersion": reference_model.VERSION_TAG}
