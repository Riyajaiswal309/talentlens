# TalentLens AI Service

**Status: Phase 2 scaffold. Not implemented.**

Per PRD §29, AI screening is **Phase 3**. This directory reserves the service
boundary so Phase 3 can be added without changing any caller.

In Phase 2 the Core API uses an in-process `NullAiProvider` that always returns
`NotScored`. This service is never called.

## Runtime

PRD §16 specifies **Python 3.11**. Check yours:

```bash
python3 --version
```

## Run (optional in Phase 2)

```bash
cd apps/ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
curl http://localhost:8000/health
```

## Not in this directory yet

No models, no training code, no datasets. Phase 3 adds `ml/training/`,
`ml/evaluation/`, and `ml/registry/` per PRD §16.1.
