# Product

## Register

product

## Users

The primary users are individual developers and power users who already run coding agents such as Codex, Claude Code, Gemini CLI, OpenCode, or similar tools on their own machines. They leave agents running while they step away from the computer and need to monitor progress, send follow-up instructions, approve risky operations, inspect changes, and recover sessions from another device.

They are comfortable installing a local daemon, but they expect the product to explain machine, workspace, agent, and permission state clearly. They care that code execution remains on their own machine and that remote access does not turn into opaque cloud execution.

## Product Purpose

This product is a unified Agent Control Center for remotely controlling coding agents running on the user's own machines. Local host daemons run and supervise the agents. A relay connects clients to those daemons for account, authorization, routing, ticket renewal, and reconnect behavior. The client experience should make active agent work visible and controllable from any surface.

Success means a user can open the product from any device, see which machines and sessions need attention, start or resume a coding-agent session, watch live progress, approve or deny permissions, inspect important outputs, and recover cleanly after network, client, relay, or daemon interruptions.

## Brand Personality

Calm, operational, and trustworthy.

The interface should feel like a serious remote work console for real machines and real code. It should be fast to scan, strong on state, and restrained enough that users trust it during long-running or risky agent work.

## Anti-references

Do not make it feel like a generic chat app, marketing dashboard, AI toy, or decorative landing page. Avoid oversized heroes, purple-blue AI gradients, ornamental cards, animated clutter, vague status text, and UI that hides where execution is happening.

The product should not imitate a cloud-only coding sandbox where code execution feels detached from the user's machine. It also should not expose ACP/runtime internals as the main product language.

## Design Principles

1. Status first: every screen should quickly answer what is running, blocked, offline, resumable, or waiting for approval.
2. Session-centered: machine, workspace, agent, permission, diff, terminal, and artifact data exist to explain or control a session.
3. Local trust is visible: show the machine, workspace path, daemon state, and execution boundary wherever a user might make a decision.
4. Blocking work floats up: permission requests, failures, reconnects, and waiting sessions should outrank passive history.
5. Recovery is product behavior: reconnect, resume, replay suppression, final client close, and daemon restart states must be understandable to users.
6. Approvals are fast and legible: risky operations need clear scope, reason, target, and one-step actions.
7. One product, many surfaces: web, mobile, desktop, and native ACP client integrations share the same object model and workflow semantics.

## Accessibility & Inclusion

The product should target at least WCAG AA contrast for text and controls. State should not rely on color alone; use labels, icons, and shape. Support reduced motion, keyboard navigation, visible focus states, text wrapping for long paths and commands, and compact layouts that remain readable on narrow screens.
