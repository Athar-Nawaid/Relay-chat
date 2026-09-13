# Project docs

Design notes, plans, and decision records for this project. Newest work appends to the end.

**Convention:** `NN-kebab-topic.md`, numbered so the sequence reads in order. Every plan, architecture decision, and design note goes here — not in chat scrollback.

| Doc | What it is |
|---|---|
| [00-cv-rebuild-plan.md](00-cv-rebuild-plan.md) | The full rebuild plan: turning the current ~530-line demo into a horizontally-scalable realtime chat worth putting on a CV. Scope cuts, hour-by-hour blocks, Postgres + MongoDB schemas, the reliability design (at-least-once delivery, watermark offline queue, TTL presence), git/PDF remediation, deployment, and the CV bullet. |
| [01-build-log.md](01-build-log.md) | What has actually been built, block by block, and every point where the implementation diverged from the plan — with the reasoning. Also tracks what is blocked on external setup. |
| [02-interview-guide.md](02-interview-guide.md) | Every feature with its rationale, the challenge it solved, and the engineering behind it — plus the bugs found, the load-test findings, and the questions an interviewer is likely to ask with answers grounded in the code. |
| [CV.md](CV.md) | Ready-to-paste CV bullets in several lengths, tailored by role, with the defensible numbers separated from the ones that would not survive a follow-up question. |
| [03-deploy-render.md](03-deploy-render.md) | Step-by-step deployment to Render's free tier: two web services from one repo sharing state through Redis, keeping the existing managed databases. |
| [04-design-decisions.md](04-design-decisions.md) | Every deliberate choice in the project — the small sharp ones — with the reason and the one line to say about each. The "why is it like that" reference. |

This folder will also hold the architecture diagram and the demo GIFs referenced in Block G of the plan.
