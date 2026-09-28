# OpenRouter production activation

CareerScope's OpenRouter integration is an optional, default-off capability.
CS-48 implements one use case only: preparation-coaching elaboration. It must
never influence matching, exclusions, ranking, identity, applications or
authorization.

## Safe release contract

Keep these values in the Hostinger runtime environment only; never put them in
GitHub issues, chat, `.env` files committed to the repository, logs or ticket
evidence:

```text
AI_ENABLED=false
OPENROUTER_API_KEY=<unset>
OPENROUTER_MODEL=<unset>
```

To activate the feature, an owner must first approve the change and then set:

```text
AI_ENABLED=true
OPENROUTER_API_KEY=<Hostinger secret value>
OPENROUTER_MODEL=<specific-model-id:free>
```

`OPENROUTER_MODEL` must be a specific model identifier ending in `:free`.
`openrouter/free` is intentionally rejected. The application checks the live
OpenRouter catalog before every uncached call and fails closed if the model is
missing or no longer free.

## Activation checklist

1. Confirm the exact model is currently listed as free immediately before the
   release. Do not record the key or prompt content.
2. Put the key and model in the Hostinger-managed runtime environment using
   the existing secret path. Do not paste either value into GitHub or this
   document.
3. Deploy a committed SHA through the manual Deploy workflow. The workflow
   must first require green CI for that exact SHA.
4. Verify `/api/health`, provenance and the preparation route. Confirm that
   the response is owner-scoped, escaped plain text and visibly marked as
   AI-generated.
5. Confirm deterministic matching and the AI-disabled fallback remain
   unchanged.
6. If any provider, catalog, rate-limit or content-safety check fails, set
   `AI_ENABLED=false` and redeploy the same reviewed release path.

## Rollback

The emergency rollback is `AI_ENABLED=false`. Remove or disable the provider
key in the Hostinger runtime environment, redeploy through the same exact-SHA
workflow, and verify that the preparation UI hides AI controls and rules-based
career preparation remains available.

CS-89 stays blocked until the owner supplies the activation approval and the
live Hostinger verification is recorded. This document is a runbook, not proof
that production AI has been enabled.
