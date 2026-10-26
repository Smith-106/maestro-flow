# Explicit Tencent Wiki projections of canonical memory

Memory projections copy one **existing, explicitly selected canonical record** to a ready Tencent Wiki asset. They are a remote reference copy—not a second authoring system, canonical store, promotion path, or automatic sync. Local Maestro knowledge remains authoritative and these operations never create, edit, delete, stage, or promote a local record.

## Supported records and scope

The runtime captures a record by canonical ID from the current physical repository. Supported sources are project Specs, Knowhow (including a selected child/subentry), Domain glossary terms, and canonical Issue JSONL rows. A physical canonical Knowhow Session record is distinct from a virtual transcript projection and may be selected if it is an actual supported source record.

Global, linked, personal, and team Specs; virtual Knowledge Graph, Session, run, and transcript entries; arbitrary files; caller-supplied page refs/bodies; and remote paths are not accepted. A source snapshot uses bounded, no-follow reads, parses the captured bytes with Maestro's existing canonical parser, and rejects collisions or a changed source. Only the selected record is projected; siblings and whole source files are not uploaded.

The remote page uses the stable reference `wiki/maestro/<repoId>/<sha256(canonicalId)>.md`. It contains locked YAML provenance/record metadata and the selected record body, with a final limit of 256 KiB UTF-8. The local source-file hash, canonical record hash, and complete remote-page hash are distinct values. The remote copy remains external/reference-only in Search; it does not become canonical authority.

## Entry points

The CLI, MCP tool, and Dashboard API all call the same runtime and therefore share the same gates and durable receipt state.

- CLI: `maestro memory preview|save|update|remove|status|reconcile <canonicalId> --provider <id> [options]`
- MCP: `maestro_memory_store` with `action`, `providerId`, and `canonicalId` (plus the action-specific fields below).
- Dashboard: `POST /api/wiki/memory` with a JSON body using that same MCP request shape. The host supplies the project/workflow root; request data cannot select a root, URL, credential, team, or agent.

There is no implicit default provider or “all providers” expansion. Select exactly one configured provider ID with `--provider`. Preview and status are local-only; preview does not read provider configuration or credentials and does not check remote existence.

## Optional write configuration

Remote reads and writes require an enabled `tencent-wiki` provider bound to the current repository. `writeEnabled` is optional and defaults to disabled; enabling writes also requires configured team, user, and agent attribution. `enabled` continues to gate all provider access. The provider's configured URL/tenant are host configuration, never caller-controlled request inputs. A ready Wiki asset must already exist. The projection runtime does not create assets, ingest documents, run an LLM, or mark an asset ready.

**Do not enable `writeEnabled` in the actual project's `.workflow/search-providers.json` to run either acceptance script.** Both scripts use a disposable synthetic repository and a synthetic credential. No production/current-repository write configuration is changed by this feature or its smoke tests. Keep write access disabled unless an owner separately reviews and deliberately configures a specific provider and ready asset.

## Preview and mutation flow

Start with a local preview and retain its `snapshot.recordHash`:

```sh
maestro memory preview spec:project:cache-policy --provider <explicit-id> --json
```

A mutation must explicitly send `write:true`, acknowledge the missing upstream compare-and-swap with `ackNoRemoteCas:true`, and supply a unique durable `operationId`. CLI equivalents are `--write`, `--ack-no-remote-cas`, and `--operation-id <id>`.

Save requires the preview's expected canonical record hash:

```sh
maestro memory save spec:project:cache-policy --provider <explicit-id> \
  --write --ack-no-remote-cas --operation-id save-cache-policy-001 \
  --expected-record-hash <recordHash> --json
```

Update requires a fresh `--expected-record-hash` and the existing managed receipt's `--expected-remote-hash` (except the explicit cascade recovery flow below). The page reference and canonical ID remain stable. Remove requires the current `--expected-remote-hash` and an explicit cascade acknowledgement:

```sh
maestro memory remove spec:project:cache-policy --provider <explicit-id> \
  --write --ack-no-remote-cas --ack-cascade --operation-id remove-cache-policy-001 \
  --expected-remote-hash <remoteContentHash> --json
```

`ackCascade:true` (`--ack-cascade`) is required because Wiki deletion may rewrite other pages. It never authorizes local-source removal. A remove can still clean up a managed projection after the local canonical source has already been removed.

The upstream API has **no atomic remote CAS and no idempotency key**. Local preflight reads and asset-level coordination cannot prevent another remote writer from racing between check and write. A matching replay of the exact same operation ID/intent returns its durable local receipt without another write; reusing that ID for a different intent is rejected. Mutations are never automatically retried. Do not treat acknowledgement or local locking as a remote transaction guarantee.

## Stored, searchable, and indeterminate are different

- `stored` means the write was followed by an exact raw-page read whose bytes match the desired page hash. It proves persistence only—not search visibility.
- Searchability is verified separately by searching the title, matching the exact page reference, and using the existing `read_page` path to verify the expected content hash. If that bounded query/read is unavailable or misses, the result is `stored-search-unverified`; that is **not proof the page is absent** and never triggers another write.
- A durable `not-sent` receipt means preparation failed **after intent persistence but before the mutation transport was invoked**. Only that persisted receipt binds the operation ID; use a new explicitly acknowledged ID after fixing the precondition. Earlier validation/readiness/read preflight failures return an error without creating a receipt, so their IDs remain reusable. Known-unsent failures do not invalidate other projections.
- `indeterminate` means a mutation may have reached the service but its outcome was not confirmed (for example, a timeout or malformed/lost response). An indeterminate/pending receipt blocks new mutations for that asset. A replay does not resend.
- `reconcile` reads the current remote page and repairs local receipt/searchability state only. It never resends a write or delete. A currently matching desired page can be confirmed stored, and an absent target after a remove can be confirmed removed. A missing/different page after an ambiguous write does not prove the write never applied; keep the state indeterminate and investigate rather than forcing a retry.

`status` reads the repository receipt manifest and the local persistent host asset ledger (for cross-worktree cascade invalidation). It reads no credentials and does not contact Tencent. `reconcile` does contact the configured remote and should be used only for an existing operation ID from that provider/record.

## Delete cascade limitation

Tencent's delete response may return `rewritten_files` as a **numeric count** rather than paths. In that case the receipt preserves the exact count as `rewrittenFileCount`, with `rewrittenFiles: []`; it does not invent filenames. Because the changed paths are unknown, the runtime advances a durable asset-wide cascade epoch at the send boundary; other managed stored projection hashes across repositories sharing the host ledger are reported invalidated by status/replay and refreshed before mutation. If the API supplies an explicit path list, those paths are recorded without truncation: each effects array allows up to 4096 paths, each path up to 2048 characters, and the complete effects JSON must fit 16 KiB UTF-8. Adapter and persisted receipts share these bounds; an oversized response after send remains indeterminate. This conservative invalidation is not a claim that each page was definitely rewritten.

### Explicit recovery after a cascade rewrite

`invalidated` means the projection was **previously confirmed stored** but a later asset-wide delete may have changed its bytes. It is not an uncertain original write. Read-only `reconcile` can restore `stored` when bytes still match the original desired hash. If bytes differ or are absent, it retains `invalidated`, the original desired hash, and unverified searchability; it does not adopt the new hash, overwrite the page, or convert this known-stored receipt into an asset-wide indeterminate-write block.

For a changed page that still exists:

1. Inspect the current remote page through the configured Search provider's `read_page` path (or the service's raw page read), review its complete content, and retain the SHA-256 of those exact UTF-8 bytes. Do not simply reuse the old receipt hash or accept unreviewed remote content.
2. Deliberately choose **update** to replace the reviewed remote bytes with a fresh canonical preview, or **remove** to delete the reviewed projection. Use a **new operation ID**, the reviewed hash as `expectedRemoteHash` / `--expected-remote-hash`, and the normal explicit write and no-CAS acknowledgements. Update still requires the fresh canonical record hash; remove still requires the cascade acknowledgement. These existing request fields are the explicit recovery authorization; there is no automatic hash-accept/force mode.
3. The runtime requires the latest receipt to be `invalidated` (or ordinary `stored` for normal operations), and a live preflight read must match the supplied hash exactly. A stale or raced hash fails `remote-conflict` before sending. The new receipt records this expected hash; the historical invalidated receipt and its desired hash remain unchanged. Replay never resends.

This exception applies **only** to previously stored cascade-invalidated projections. Pending/indeterminate writes, including unresolved deletes in the shared host ledger, continue to block new mutations even if the caller supplies a currently matching hash. Ordinary stored receipts still require their recorded hash. Missing cascade-invalidated pages are not silently re-created or classified as unsent; retain the invalidation and investigate. External writers can still race after preflight because upstream has no CAS.

## State, locking, and recovery

Durable operation receipts live under the current repository's `.workflow/memory-projections/`. They store hashes, provenance, operation intent, and state—not credentials or page content. The asset lock is local cross-process coordination only; it does not lock the remote Wiki or external writers. Corrupt, linked, oversized, or otherwise unsafe receipt state fails closed.

Lock directories are named `<sha256(asset-key)>.lock`. Both the repository state directory and the persistent per-user asset directory (`<os.homedir()>/.maestro/memory-projection-assets/`) are locked, coordinating the same endpoint/service/wiki across physical repositories sharing that home. A bounded asset ledger there retains unresolved send ownership and a cascade invalidation epoch, so ambiguity and deletion effects survive process exit and reach other worktrees' receipts. Separate users, homes and hosts remain external writers; there is still no remote CAS. There is no age-based timeout or automatic stale-lock stealing: a live process may still be waiting on HTTP. If `asset-locked` persists, stop issuing new mutations. Confirm through the owning process/session supervisor that **every process capable of holding that asset lock is actually dead**; age alone, a missing terminal message, or a timeout is not proof. Preserve a copy of the manifest, inspect the relevant receipt with `status` and (when safe) `reconcile`, and only then consider manually removing the exact stale lock directories (repository and persistent host asset location). Do not delete or edit repository receipts or the persistent host asset ledger to pretend a mutation did not happen. Preserve/restore both when moving bookkeeping; separate or missing homes cannot establish unsent proof. When remote state is ambiguous, retain the block and resolve it from observed remote state rather than retrying. After a pre-send crash, `reconcile` can classify a local pending intent as `not-sent` only when the same durable host-ledger generation has no send marker; a missing/replaced/legacy ledger cannot establish this proof.

## Acceptance checks

After a successful root-coordinated build, the hermetic acceptance script can be run with:

```sh
node scripts/check-memory-projection-smoke.mjs
```

It creates a synthetic temporary repository, starts an ephemeral 127.0.0.1 HTTP mock, and runs the **built** CLI, MCP handler, and Dashboard route through a network guard that rejects any connection except that exact mock address/port. It checks local-only preview/probe/status, disabled gates, hash checks, save/search/read hash verification, source immutability, update/remove, cascade invalidation, operation replay, ambiguous writes, and non-resending reconciliation. Focused `src/memory/runtime.test.ts` tests additionally exercise actual cascade link rewrites, explicit hash-pinned update/remove recovery, and adapter-to-manifest persistence of 2049 short delete-effect paths. It does not use an inherited user credential or touch the actual repository's provider configuration.

The optional live acceptance script is separate and must only be run after root coordinates a successful build and confirms the existing isolated Knowledge service is available:

```sh
node .tmp/tencent-live-test/verify-projections.mjs
```

It uses **only the already-running Knowledge API on 127.0.0.1:8421** and its existing synthetic ready Wiki fixture; it never starts/stops services or contacts MemoryCore. It creates a disposable repository and provider config outside the actual repository, uses a synthetic test identity, and writes only a unique synthetic canonical projection. It hashes and re-reads the fixture page before/after and does not edit/delete it. If a live mutation becomes ambiguous, the script does not blindly retry; it retains the temporary repository and reports the synthetic page reference for reconciliation. Do not run this live script until the root/maintainer coordinates the build.
