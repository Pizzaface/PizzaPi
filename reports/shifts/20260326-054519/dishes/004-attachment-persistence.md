# Dish 004: User Attachment Persistence — SQLite Persist + Rehydration on Boot

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** cmHfFF7I
- **Dependencies:** none
- **Pairing:** none
- **Paired:** false
- **Files:** packages/server/src/attachments/store.ts, packages/server/src/migrations.ts
- **Verification:** cd packages/server && bun run typecheck; bun test packages/server
- **Status:** cooking
- **Session:** e196cbb5-6193-4e4a-b2b3-d94853893b52
- **dispatchPriority:** normal

## Task Description

### Problem
`storeSessionAttachment()` (store.ts:62–95) writes user-uploaded attachments to disk AND to an in-memory Map, but **never persists to SQLite**. On server restart:
- The files are still on disk (in `~/.pizzapi/session-attachments/`)
- But the in-memory Map is empty
- All attachment GET requests return 404

System/extracted attachments already have SQLite persistence via `persistExtractedAttachment()` and `ensureExtractedAttachmentTable()`. The fix extends this pattern to user-uploaded attachments.

### Fix

**Option A: Reuse existing extracted_attachment table with a type discriminator**
The `extracted_attachment` table already exists and has the right shape. Add a `type` column (or use `uploaderUserId !== "system"` as the discriminator). User-uploaded attachments get the same persist/rehydrate path.

**Option B: New table `session_attachment`**
Create a separate `session_attachment` table mirroring the schema of `extracted_attachment` but for user uploads. This is cleaner semantically.

**Recommendation:** Use Option A (reuse `extracted_attachment` table) since the schema already matches. Add a `type TEXT NOT NULL DEFAULT 'extracted'` discriminator column using `ifNotExists` to stay idempotent. This minimizes migration risk.

### Implementation Steps

1. **In `store.ts`, add persist call in `storeSessionAttachment`:**
   ```ts
   // After attachments.set(attachmentId, record):
   void persistExtractedAttachment(record).catch((err) => {
       logWarn("Failed to persist user attachment to SQLite:", err);
   });
   ```
   (Same fire-and-forget pattern used by system attachments at line 117)

2. **Update `ensureExtractedAttachmentTable`** to add a `uploader_type` or use the existing `uploader_user_id` column to distinguish system vs. user uploads. Check if the column already exists before adding (idempotent migration).

3. **Update `rehydrateExtractedAttachments`** (or add `rehydrateUserAttachments`) to load user-uploaded records on boot:
   - Load all non-expired records from the `extracted_attachment` table
   - Add them to the in-memory `attachments` Map
   - The existing function currently loads system attachments — extend or call after it

4. **Call rehydration in server startup**: Check `packages/server/src/index.ts` or the boot sequence to ensure `rehydrateExtractedAttachments()` (which now covers user uploads too) is called. It may already be called.

5. **In `migrations.ts`**: no changes needed if reusing existing table — `ensureExtractedAttachmentTable` already handles schema creation.

### Critical Constraints
- The migration MUST be idempotent — `createTable` calls should use `ifNotExists` (they already do, per the existing code pattern)
- Do NOT break existing extracted/system attachment persistence — only ADD to the persist flow
- Verify `rehydrateExtractedAttachments` is called at server startup — check `packages/server/src/index.ts`
- Do NOT change the `getStoredAttachment` or `deleteStoredAttachment` functions' signatures

### Verification
```bash
cd packages/server && bun run typecheck
bun test packages/server
```
TypeScript must be clean. Tests must pass (especially any attachment store tests).

## Status History
| Time | Status | Notes |
|------|--------|-------|
| 05:52 | queued | Created in Prep — Band B, normal priority |
