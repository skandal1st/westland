# Implementation Plan: Hybrid Activation And Local Perpetual Grant

## Selected Design And Constraints

The selected design uses an AXIMA-owned activation service and a publisher-signed local grant bound to an Ed25519 installation keypair generated on the client server. Runtime entitlement is perpetual for the acquired release and does not require heartbeat. The first slice defaults to one production activation and keeps policy fields versioned rather than hard-coded.

## Source Revision And Drift Check

The repository has no resolvable `HEAD`; all current files are untracked, so drift cannot be bound to a commit. Implementation is anchored to evidence collection digest `db3c8c413c23b859392785599d3af00e2e74106702ff44f9e2e2122d73c20072`. Before production rollout we must create an immutable repository revision and refresh this plan.

## Affected Components

- `packages/license-core/`: canonical payload, signing, verification and capability resolution.
- `scripts/install.mjs`: interactive/config-driven plan and apply workflow.
- `services/license-server/`: separate activation authority and administration tooling.
- `config/` and `secrets/`: generated deployment state, excluded from Git.
- `package.json`: operator entrypoints.
- Later slices: application boot guard, module API enforcement and database bootstrap.

## Ordered Work Packages

1. Define versioned grant/envelope contracts and canonical serialization.
2. Implement Ed25519 signing, local identity binding and capability intersection.
3. Implement license-server key generation, license issuance and activation endpoint.
4. Implement install CLI `plan` and `apply`, safe secret input and atomic persistence.
5. Add tests for tampering, wrong identity, module intersection and activation limits.
6. Connect verified capabilities to application boot and server-side module boundaries.
7. Add Prisma migration/bootstrap, SMTP test and operational recovery/transfer commands.

## Compatibility And Migration

Current development remains runnable because enforcement is not connected to application boot in the first slice. Production mode must not receive that bypass. Generated files use explicit schema versions, and future readers reject unknown major versions. Existing installations will require assisted identity generation and activation before enforcement is enabled.

## Tactical Protections During Migration

- Generated `config/`, `secrets/` and license-server state are ignored by Git.
- Private keys and runtime secret files are written with owner-only permissions where supported.
- Activation keys and SMTP passwords are not accepted through ordinary command-line values.
- The licensing service stores activation-key hashes, not plaintext keys.
- Module visibility remains informational until server-side guards are wired.

## Tests And Security Validation

- Valid grant verifies against its publisher key and installation private key.
- Payload or signature modification fails closed.
- A grant copied without the matching private key fails.
- Requested modules cannot exceed issued entitlements.
- A second production installation exceeds a one-seat license.
- Repeated activation for the same installation is idempotent.
- Installer plan creates no secrets or identity.
- Installer apply never overwrites existing identity implicitly.

## Performance And Resource Benchmarks

Measure local verification during cold start and activation endpoint latency with a small license store. Initial acceptance targets are operational rather than optimized: verification must stay outside request hot paths and activation must have bounded request bodies and timeouts. Final thresholds will be set from measured results.

## Rollout And Rollback

Run the first activation on a disposable Westside environment, then an assisted server installation. Back up the installation identity and signed grant before enforcing capabilities. Rollback uses the previous application release plus the last valid grant; no rollback step deletes installation keys or customer data.

## Acceptance Criteria

- The shared contract and tests pass.
- The activation server issues only entitled modules and respects seat limits.
- The installer produces validated profile, protected secrets, installation identity and signed grant.
- A valid activated installation verifies with all network access to AXIMA blocked.
- A partial copy cannot verify the grant.
- Production application enforcement is not claimed until its later guard slice lands.

## Open Decisions

- Whether one purchase also includes a staging seat.
- Update entitlement policy and publisher-key rotation cadence.
- Transfer overlap duration.
- Whether offline request/response activation is mandatory in the first production release.

