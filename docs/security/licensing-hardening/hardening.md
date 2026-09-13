# Security Hardening Review: Self-Hosted Installation And Licensing

## Evidence Basis

I inspected the current platform boundary, Prisma schema, ERP port and package scripts. AXIMA already has store-scoped commerce entities and replaceable ERP contracts, but it has no installer, installation identity or runtime license verifier yet. The evidence collection and hashes are recorded in [`context.md`](./context.md).

## Constraints

We are designing a self-hosted product whose runtime should remain useful when AXIMA infrastructure is temporarily unavailable. We want to discourage ordinary reuse of one purchased installation, not claim DRM against a customer with root access. No measured activation latency, fleet size or support SLA has been supplied, so the comparison uses a balanced reliability/security profile.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Trusted bootstrap and installation-bound entitlement | Platform/deployment boundary (E001–E005) | 1. Offline signed file; 2. Hybrid activation and local grant; 3. Online lease | Option 2 under current constraints | [Full proposal](./proposals/trusted-self-hosted-bootstrap.md) |

## Recommendation Summary

I recommend Option 2: the installer generates an installation key locally, activates a purchase against the AXIMA licensing server and receives a publisher-signed local grant. The application verifies the grant locally at startup and before privileged module operations. The grant does not require a continuous heartbeat and a licensing outage does not stop an already activated store.

This prevents the casual path where a buyer copies only the application and configuration to a second server. We should be explicit about the residual boundary: a full clone that includes the database, license grant and installation private key can still run. Hardware fingerprinting or an always-online lease would narrow that path, but at a reliability and support cost that is not proportionate here.

## Next Decisions

- Option 2 is selected; follow the [implementation plan](./implementation/hybrid-activation-local-grant.md).
- Decide whether a purchase grants one production installation plus one staging installation.
- Confirm perpetual runtime entitlement and define whether updates are limited by purchase date, major version or support term.
- Confirm Docker Compose as the first supported installation target.
- Define transfer policy: deactivate old installation first, or permit a short audited overlap.
