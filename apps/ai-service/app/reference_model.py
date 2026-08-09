"""
Deterministic reference implementation of the §19–§22 pipeline.

THIS IS NOT A TRAINED MODEL.

No model has been trained for TalentLens and none can be, here: PRD §19.2
requires consent-gated historical application data, recruiter accept/reject/
hire labels, a licensed resume corpus, a human-verified golden NER dataset,
and an access-restricted fairness dataset. None of those exist.

What this module provides instead is a deterministic stand-in whose only
purpose is to exercise the INTEGRATION: the queue, the parse lifecycle, the
atomic score write, BR-02 and BR-07 enforcement, and the rendering path. It
is:

  * not a trained ML model
  * not production-validated
  * not promotable under PRD §19.6 — the fairness gate has no override path,
    and there is no fairness dataset to evaluate it against
  * not evidence of parsing, ranking or fairness performance

Every value it returns is a function of the input text, chosen to be stable
across runs so tests can assert on it. Nothing here is a prediction.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

MODEL_NAME = "reference-stub"
VERSION_TAG = "not-trained-v0"

# PRD §19.3 Table 19.1 — the only permitted model inputs (BR-07).
ALLOWED_FEATURES = (
    "semantic_similarity",
    "skill_overlap",
    "years_experience_delta",
    "education_match",
    "recency_relevant_exp",
    "certification_match",
)

# PRD §20 stage 5 / FR3.2.
CONFIDENCE_THRESHOLD = 0.75

_SKILL_HINTS = (
    "python", "sql", "typescript", "javascript", "java", "go", "rust",
    "react", "nestjs", "postgres", "kubernetes", "docker", "aws",
)
_DEGREE = re.compile(r"\b(b\.?tech|b\.?sc|m\.?tech|m\.?sc|phd|bachelor|master)\b", re.I)
_YEARS = re.compile(r"\b(\d{1,2})\+?\s*(?:years?|yrs?)\b", re.I)


def _stable_unit(*parts: str) -> float:
    """A repeatable number in [0, 1] derived from the input.

    Deterministic on purpose: an integration test must be able to assert an
    exact value. This is arithmetic on a hash, not inference.
    """
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 0xFFFFFFFF


def parse(resume_id: str, text: str) -> dict[str, Any]:
    """Extract structure from resume text.

    Keyword matching, not NER. §20 stages 2-6 describe pdfplumber, spaCy,
    OCR fallback and a canonical skill taxonomy; none of that is implemented,
    because a fine-tuned spaCy pipeline requires the labelled corpus §19.2
    calls for.
    """
    lowered = text.lower()

    skills = [skill for skill in _SKILL_HINTS if skill in lowered]
    education = [{"degree": match.group(0)} for match in _DEGREE.finditer(text)][:3]
    certifications: list[dict[str, Any]] = []

    years = [int(m.group(1)) for m in _YEARS.finditer(text)]
    work_history = [{"years": max(years)}] if years else []

    # FR3.2 — a per-field confidence for everything extracted. Fields the
    # stub had least evidence for land below the 0.75 threshold and are
    # flagged for human review rather than accepted.
    field_confidence: dict[str, float] = {}
    for index, skill in enumerate(skills):
        field_confidence[f"skills[{index}]"] = round(0.6 + 0.4 * _stable_unit(resume_id, skill), 4)
    for index, _ in enumerate(education):
        field_confidence[f"education[{index}].degree"] = round(
            0.5 + 0.5 * _stable_unit(resume_id, "edu", str(index)), 4
        )
    if work_history:
        field_confidence["work_history[0].years"] = round(
            0.4 + 0.5 * _stable_unit(resume_id, "years"), 4
        )

    overall = (
        round(sum(field_confidence.values()) / len(field_confidence), 4)
        if field_confidence
        else 0.0
    )

    return {
        "skills": skills,
        "workHistory": work_history,
        "education": education,
        "certifications": certifications,
        "fieldConfidence": field_confidence,
        "overallConfidence": overall,
    }


def rank(application_id: str, profile: dict[str, Any], weights: dict[str, float]) -> dict[str, Any]:
    """Produce a composite score, feature vector and rationale.

    NOT a bi-encoder, NOT LightGBM, and the rationale is NOT SHAP. §21-§22
    specify sentence-transformers, a gradient-boosted re-ranker and SHAP
    attribution; all three need trained artefacts that do not exist.

    The shape is exact, because that is what the integration must handle:
    every feature is on the Table 19.1 allow-list (BR-07), and a rationale is
    always present (BR-02) — the core API aborts the write without one.
    """
    features = {
        name: round(_stable_unit(application_id, name), 4) for name in ALLOWED_FEATURES
    }

    composite = sum(features[name] * weights.get(name, 0.0) for name in ALLOWED_FEATURES)
    composite = round(min(max(composite, 0.0), 1.0), 4)

    contributions = sorted(
        ((name, round(features[name] * weights.get(name, 0.0), 4)) for name in ALLOWED_FEATURES),
        key=lambda pair: pair[1],
        reverse=True,
    )

    # §22.2 — top three positive and top one negative, templated rather than
    # generated, so the sentence cannot drift from the numbers behind it.
    top = contributions[:3]
    bottom = contributions[-1]
    summary = (
        "Reference stub: strongest signals were "
        + ", ".join(name.replace("_", " ") for name, _ in top)
        + f"; weakest was {bottom[0].replace('_', ' ')}. "
        "Not a trained model — this explanation is illustrative only."
    )

    factors = [
        {"feature": name, "contribution": value, "direction": "positive"} for name, value in top
    ] + [{"feature": bottom[0], "contribution": -abs(bottom[1]), "direction": "negative"}]

    return {
        "composite": composite,
        "featureVector": features,
        "rationale": {"summary": summary, "factors": factors},
        "modelName": MODEL_NAME,
        "versionTag": VERSION_TAG,
    }
