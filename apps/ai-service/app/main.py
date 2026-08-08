"""TalentLens AI Service — Phase 2 scaffold.

SCOPE: this service exposes a liveness probe and nothing else.

Per PRD §29, AI screening is Phase 3 (P3), not Phase 2 (P2). No parsing,
embedding, ranking, explainability, or model loading exists here yet.

In Phase 2 the Core API talks to a NullAiProvider in-process and never calls
this service. The HTTP surface below reserves the integration boundary so
Phase 3 can fill it without changing any caller.

Phase 3 will add (PRD §23.2 Table 23.2):
    POST /internal/ai/parse    - resume -> structured profile
    POST /internal/ai/rank     - application -> composite score
    POST /internal/ai/explain  - score -> SHAP attribution

Binding constraints on those endpoints (PRD §13):
    BR-02  a score may never be returned without a rationale
    BR-07  features are restricted to the PRD Table 19.1 allow-list
    BR-01  no AI output may transition an application's stage
"""

from datetime import datetime, timezone

from fastapi import FastAPI

app = FastAPI(
    title="TalentLens AI Service",
    version="0.1.0",
    description="Phase 2 scaffold. AI capabilities arrive in Phase 3.",
)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe (PRD §25.1)."""
    return {
        "status": "ok",
        "service": "talentlens-ai-service",
        "phase": "2-scaffold",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
