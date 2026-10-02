# Agent Guidelines & Persistent Rules

## Persistent Project Rules (DO NOT OVERRIDE)

1. **Model Selection Policy**:
   - **GEMINI API FIRST (FREE FIRST ALWAYS)**: Query Google Gemini Developer API (free models first) using `GEMINI_API_KEY` or `API_KEY`. Do not use Vertex AI first.
   - Priority free model sequence:
     1. `gemini-3.6-flash`
     2. `gemini-3.6-flash-lite`
     3. `gemini-3.5-flash`
     4. `gemini-3.5-flash-lite`
     5. `gemini-1.5-flash` (Omni 1.5)
     6. `gemini-3.1-flash-lite`
     7. `gemini-flash-latest`
   - DigitalOcean GenAI Inference (`glm-3.5-flash`) acts as a secondary fallback only if Google Gemini API free limits are exhausted.
   - Large concurrency enabled for batch synthesis across frontend and backend.

2. **Persistence Rules**:
   - Uses local `.data/projects.json` file storage as a fail-safe offline fallback alongside Firestore to prevent quota limits from blocking project loading and saving.

3. **No Automated Downgrades**:
   - Preserve modern Gemini API initializations and configuration across edits.

4. **Data Registry Approval Policy**:
   - All generated, converted, or imported batches MUST start with `status: "Pending"` and must NOT be added to the active Data Registry until explicitly reviewed and approved by the user.
   - **Exception**: TRiAD alignment batches are pre-aligned preference sets and are the ONLY batches that enter the Data Registry directly as `Approved`.
