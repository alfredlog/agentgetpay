@AGENTS.md

# AgentGetPay
Spend-control layer for AI agents on BSV (TUM Blockchain & AI Hackathon 2026, BSV track).

## Project rules
- Read BSV_STACK_COMPLETE_GUIDE.md (docs/) before any BSV code; prefer its Appendix A code.
- Code comments in English. Small, focused changes; one branch per step.
- Keep all existing tests green (npm run test:*); add tests for new flows.
- Never commit .env, keys or wallet databases; never print keys in logs.
- The company's funds stay in the company's BSV Desktop wallet: no single server key may control them.