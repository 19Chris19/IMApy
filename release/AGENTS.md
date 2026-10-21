# IMApy development

Use Node 22. The personal SDK is independent of Provider A. Keep protocol code in
ima-core, personal state in ima-runtime and shared CLI/MCP workflows in ima-agent.
Provider adapters are experimental trusted-host interfaces, not deployment tools.

Only the eight core capability groups in README/ACCEPTANCE are in the alpha's
supported scope, limited to their recorded evidence. Do not promote roadmap,
experimental interfaces or partial material mapping into supported features.
Agent/Skill real use, cross-day maintenance and production migration have separate
acceptance gates; future features are subject to web feasibility and validation.

Run `npm ci --ignore-scripts`, then build, pack and the complete offline test suite.
Tests must block real upstream access and use private temporary synthetic profiles.
Import, local status and MCP startup must not log in, refresh, ask or open a browser.

Real login, refresh, queries, original reads, host registration and deployment need
the human's explicit scope. Never import another profile or production pool as a
fallback. Preserve original request keys and uncertain-dispatch fences; no blind retry.
Do not alter installed Agent configs or existing services during normal tests.

Keep MIT attribution, original-source hashes and separate implementation, synthetic,
historical real, endurance and release evidence. Tool discovery is not QA acceptance.
Do not commit credentials, profiles, raw captures or real questions/answers.
